import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  AnalysisPipeline,
  CatalystClassifier,
  ConfidenceEngine,
  createAnalystWriterFromEnv,
  debugGeminiFromEnv
} from "@market-desk/analysis-engine";
import { ComplianceEngine } from "@market-desk/compliance";
import { MarketSnapshotService, SnapshotNotFoundError } from "@market-desk/core";
import { createMockProviderBundle, createProviderBundleFromEnv, detectAssetType, ProviderBundle } from "@market-desk/data-providers";
import { analysisModeSchema, MarketSnapshot } from "@market-desk/shared";
import { TelegramClient, extractCallbackData, extractMessageText, parseTelegramCommand } from "@market-desk/telegram";
import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import { z } from "zod";
import { isApiAuthRequired, requireRole, roleFromRequest } from "./auth";
import { handleTelegramCommand } from "./commands";
import { captureException } from "./error-tracking";
import { PublishingDraftStore, PublishingService, actionFromCallbackData, publishingModeFromEnv } from "./publishing";
import { scheduledJobs } from "./scheduler";

export interface MarketDeskServices {
  snapshots: MarketSnapshotService;
  pipeline: AnalysisPipeline;
  compliance: ComplianceEngine;
  telegram: TelegramClient;
  providers: ProviderBundle;
  publishing: PublishingService;
  draftStore: PublishingDraftStore;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  services?: MarketDeskServices;
}

export function createServices(): MarketDeskServices {
  const providers = createProviderBundleFromEnv(process.env, createMockProviderBundle());
  const snapshots = new MarketSnapshotService(providers);
  const compliance = new ComplianceEngine();
  const telegram = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_DEFAULT_CHAT_ID);
  const draftStore = new PublishingDraftStore();
  const pipeline = new AnalysisPipeline(
    snapshots,
    undefined,
    undefined,
    createAnalystWriterFromEnv(process.env),
    compliance
  );
  const publishing = new PublishingService({
    pipeline,
    telegram,
    store: draftStore,
    publishingMode: publishingModeFromEnv(process.env),
    publicChannelId: process.env.TELEGRAM_PUBLIC_CHANNEL_ID ?? process.env.TELEGRAM_DEFAULT_CHAT_ID,
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
    maxAutoPostsPerDay: Number(process.env.MAX_AUTO_POSTS_PER_DAY ?? 20)
  });

  return {
    snapshots,
    pipeline,
    compliance,
    telegram,
    providers,
    publishing,
    draftStore
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const services = options.services ?? createServices();

  await app.register(cors, { origin: corsOrigins() ?? true });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute"
  });
  app.log.info({ ai: services.pipeline.getAiStatus() }, "AI writer configured.");

  app.setErrorHandler((error, _request, reply) => {
    captureException(error, { source: "fastify_error_handler" });
    if (error instanceof SnapshotNotFoundError) {
      reply.status(404).send({ error: error.message });
      return;
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : "Internal server error.";
    reply.status(statusCode).send({ error: message });
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    version: "0.1.0",
    environment: process.env.NODE_ENV ?? "development",
    service: "market-desk-engine",
    providers: process.env.NODE_ENV === "production" ? "live" : "live-with-dev-mock-fallback",
    authRequired: isApiAuthRequired()
  }));

  app.get("/health/providers", async () => ({
    ok: true,
    providers: services.providers.health?.getProviderHealth() ?? [],
    configured: {
      twelveData: Boolean(process.env.TWELVE_DATA_API_KEY),
      finnhub: Boolean(process.env.FINNHUB_API_KEY),
      fred: Boolean(process.env.FRED_API_KEY),
      sec: Boolean(process.env.SEC_USER_AGENT),
      redis: Boolean(process.env.REDIS_URL),
      database: Boolean(process.env.DATABASE_URL)
    }
  }));

  app.get("/debug/ai/gemini", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async () => {
    const result = await debugGeminiFromEnv(process.env);
    return {
      ...result,
      errorMessage: result.errorMessage ? sanitizeDebugMessage(result.errorMessage) : null
    };
  });

  app.get("/debug/provider/:asset", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async (request) => {
    const params = z.object({ asset: z.string().min(1) }).parse(request.params);
    const query = z.object({ refresh: z.coerce.boolean().optional() }).parse(request.query);
    const assetType = detectAssetType(params.asset);
    const providerWithDebug = services.providers.marketData as unknown as {
      debugAsset?: (asset: string, refresh?: boolean) => Promise<Record<string, unknown>>;
    };
    const providerDebug = providerWithDebug.debugAsset
      ? await providerWithDebug.debugAsset(params.asset, query.refresh ?? false).catch((error) => ({
          requestedAsset: params.asset,
          detectedAssetType: assetType,
          selectedProvider: process.env.MARKET_DATA_PROVIDER ?? "provider_router",
          providerRequestStatus: "error",
          providerErrors: [sanitizeDebugMessage(error instanceof Error ? error.message : String(error))]
        }))
      : undefined;
    const debugRecord = providerDebug as Record<string, unknown> | undefined;

    const quote = await quoteForDebug(services, params.asset, assetType);
    const snapshot = await snapshotForDebug(services, params.asset, assetType);
    const classifier = new CatalystClassifier();
    const confidenceEngine = new ConfidenceEngine();
    const catalysts = snapshot ? classifier.classify(snapshot) : [];
    const confidence = snapshot ? confidenceEngine.score({ ...snapshot, detectedCatalysts: catalysts } as MarketSnapshot, catalysts) : undefined;
    const aiStatus = services.pipeline.getAiStatus();
    const quoteFound = Boolean(quote || debugRecord?.sanitizedData || snapshot);
    const geminiEligible =
      quoteFound &&
      assetType !== "index" &&
      aiStatus.provider.toLowerCase() === "gemini" &&
      Boolean(aiStatus.geminiConfigured ?? aiStatus.configured);
    const geminiDailyLimitReached = aiStatus.todayAttemptedAiCalls >= aiStatus.maxGenerationsPerDay;
    const geminiWouldBeCalled = geminiEligible && !geminiDailyLimitReached && Boolean(snapshot);
    const contextCounts = contextCheckCounts(snapshot, assetType);

    return {
      requestedAsset: params.asset,
      detectedAssetType: assetType,
      quoteFound,
      selectedProvider: debugRecord?.selectedProvider ?? process.env.MARKET_DATA_PROVIDER ?? "provider_router",
      normalizedSymbol: debugRecord?.normalizedSymbol ?? quote?.providerSymbol ?? quote?.symbol,
      providerResponseStatus: debugRecord?.providerRequestStatus ?? (quote ? "ok" : "not_found"),
      providerRequestStatus: debugRecord?.providerRequestStatus ?? (quote ? "ok" : "not_found"),
      sanitizedData: debugRecord?.sanitizedData ?? (quote
        ? {
            symbol: quote.symbol,
            providerSymbol: quote.providerSymbol,
            assetClass: quote.assetClass,
            price: quote.price,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            previousClose: quote.previousClose,
            percentChange: quote.percentChange,
            asOf: quote.asOf,
            sourceName: quote.sourceName,
            providerStatus: quote.providerStatus
          }
        : null),
      sourceTimestamps: quote?.asOf ? [quote.asOf] : [],
      providerErrors: services.providers.health?.getProviderHealth().map((item) => item.message).filter(Boolean) ?? [],
      newsChecked: contextCounts.newsChecked,
      newsCount: contextCounts.newsCount,
      macroChecked: contextCounts.macroChecked,
      macroCount: contextCounts.macroCount,
      catalystLabel: catalysts[0]?.label ?? "unavailable",
      catalystConfidence: confidence?.score ?? null,
      geminiEligible,
      geminiWouldBeCalled,
      fallbackReason: geminiWouldBeCalled
        ? null
        : debugFallbackReason({ quoteFound, assetType, snapshotFound: Boolean(snapshot), aiStatus, geminiDailyLimitReached })
    };
  });

  app.get("/why/:symbol", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async (request) => {
    const params = z.object({ symbol: z.string().min(1) }).parse(request.params);
    const query = z.object({ mode: analysisModeSchema.optional() }).parse(request.query);
    return services.pipeline.analyzeEquity(params.symbol, query.mode ?? "equity_mover_reaction");
  });

  app.get("/forex/:pair", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async (request) => {
    const params = z.object({ pair: z.string().min(1) }).parse(request.params);
    const query = z.object({ mode: analysisModeSchema.optional() }).parse(request.query);
    return services.pipeline.analyzeForex(params.pair, query.mode ?? "forex_reaction");
  });

  app.get("/commodity/:asset", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async (request) => {
    const params = z.object({ asset: z.string().min(1) }).parse(request.params);
    const query = z.object({ mode: analysisModeSchema.optional() }).parse(request.query);
    return services.pipeline.analyzeCommodity(params.asset, query.mode ?? "commodity_reaction");
  });

  app.get("/movers", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async () => ({
    movers: await services.providers.marketData.getMovers(8)
  }));

  app.post("/riskcheck", { preHandler: requireRole(["analyst", "admin"]) }, async (request) => {
    const body = z.object({ text: z.string().min(1), confidenceScore: z.number().optional() }).parse(request.body);
    return services.compliance.review(body.text, {
      confidenceScore: body.confidenceScore,
      sourceCount: 1,
      publicOutput: true
    });
  });

  app.get("/scheduler/status", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async () => ({
    enabled: process.env.ENABLE_SCHEDULER === "true",
    timezone: process.env.MARKET_TIMEZONE ?? "Africa/Lagos",
    jobs: scheduledJobs
  }));

  app.get("/dashboard", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async () => {
    const [nvda, eurusd, gold, movers] = await Promise.all([
      services.pipeline.analyzeEquity("NVDA", "dashboard_brief"),
      services.pipeline.analyzeForex("EURUSD", "dashboard_brief"),
      services.pipeline.analyzeCommodity("GOLD", "dashboard_brief"),
      services.providers.marketData.getMovers(6)
    ]);
    const [nvdaDraft, eurusdDraft, goldDraft] = await Promise.all([
      services.publishing.upsertDashboardPreview({
        symbol: "NVDA",
        assetClass: "equity",
        result: nvda,
        mode: "dashboard_brief"
      }),
      services.publishing.upsertDashboardPreview({
        symbol: "EURUSD",
        assetClass: "forex",
        result: eurusd,
        mode: "dashboard_brief"
      }),
      services.publishing.upsertDashboardPreview({
        symbol: "GOLD",
        assetClass: "commodity",
        result: gold,
        mode: "dashboard_brief"
      })
    ]);

    return {
      snapshots: [nvdaDraft, eurusdDraft, goldDraft].map((record) => ({
        ...record.result,
        publishing: {
          id: record.id,
          status: record.status,
          decision: record.decision,
          disabledForToday: record.disabledForToday ?? false
        }
      })),
      movers,
      watchlist: ["AAPL", "NVDA", "TSLA", "EURUSD", "GBPUSD", "GOLD", "OIL", "NATGAS", "DXY"],
      scheduler: {
        enabled: process.env.ENABLE_SCHEDULER === "true",
        jobs: scheduledJobs
      },
      aiStatus: services.pipeline.getAiStatus(),
      postHistory: services.publishing
        .listDrafts()
        .filter((draft) => draft.publishedAt)
        .map((draft) => ({
          id: draft.id,
          symbol: draft.symbol,
          channel: draft.status,
          publishedAt: draft.publishedAt
        }))
    };
  });

  app.get("/publishing/drafts", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async () => ({
    drafts: services.publishing.listDrafts()
  }));

  app.post("/publishing/drafts", { preHandler: requireRole(["analyst", "admin"]) }, async (request) => {
    const body = z
      .object({
        symbol: z.string().min(1),
        assetClass: z.enum(["equity", "forex", "commodity"]).optional(),
        mode: analysisModeSchema.optional()
      })
      .parse(request.body);
    return services.publishing.createDraft({
      symbol: body.symbol,
      assetClass: body.assetClass,
      mode: body.mode
    });
  });

  app.post("/publishing/drafts/:id/actions", { preHandler: requireRole(["analyst", "admin"]) }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        action: z.enum([
          "approve",
          "reject",
          "regenerate",
          "make_sharper",
          "make_shorter",
          "add_macro_context",
          "add_source_summary",
          "disable_asset_today"
        ])
      })
      .parse(request.body);
    if (isApiAuthRequired() && ["approve", "disable_asset_today"].includes(body.action)) {
      const role = roleFromRequest(request);
      if (role !== "admin") {
        reply.status(403);
        return { error: "Admin role required for this publishing action." };
      }
    }
    return services.publishing.handleAction(params.id, body.action);
  });

  app.post("/webhooks/telegram", async (request, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && request.headers["x-telegram-bot-api-secret-token"] !== secret) {
      reply.status(401);
      return { ok: false, error: "Invalid Telegram webhook secret." };
    }

    const update = request.body as Parameters<typeof extractMessageText>[0];
    const callback = extractCallbackData(update);
    if (callback) {
      const action = actionFromCallbackData(callback.data);
      if (!action) {
        await services.telegram.answerCallbackQuery({
          callbackQueryId: callback.callbackQueryId,
          text: "Unknown action."
        });
        return { ok: false, ignored: true };
      }
      const result = await services.publishing.handleAction(action.id, action.action);
      await services.telegram.answerCallbackQuery({
        callbackQueryId: callback.callbackQueryId,
        text: result.message
      });
      return { ok: true, result };
    }

    const message = extractMessageText(update);
    if (!message) {
      return { ok: true, ignored: true };
    }

    const parsed = parseTelegramCommand(message.text);
    if (!parsed) {
      return { ok: true, ignored: true };
    }

    const result = await handleTelegramCommand(
      parsed,
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: services.providers.health
      },
      message.chatId
    );

    if (parsed.command !== "/post") {
      await services.telegram.sendMessage({ chatId: message.chatId, text: result.text });
    }

    return { ok: result.status === "ok", result };
  });

  return app;
}

type DebugAssetType = ReturnType<typeof detectAssetType>;

async function quoteForDebug(
  services: MarketDeskServices,
  asset: string,
  assetType: DebugAssetType
) {
  try {
    if (assetType === "forex") {
      return await services.providers.marketData.getForexQuote(asset);
    }
    if (assetType === "commodity") {
      return await services.providers.marketData.getCommodityQuote(asset);
    }
    if (assetType === "index") {
      return await services.providers.marketData.getIndexMove(asset);
    }
    return await services.providers.marketData.getEquityQuote(asset);
  } catch {
    return null;
  }
}

async function snapshotForDebug(
  services: MarketDeskServices,
  asset: string,
  assetType: DebugAssetType
): Promise<MarketSnapshot | null> {
  try {
    if (assetType === "forex") {
      return await services.snapshots.getForexSnapshot(asset);
    }
    if (assetType === "commodity") {
      return await services.snapshots.getCommoditySnapshot(asset);
    }
    if (assetType === "equity") {
      return await services.snapshots.getEquitySnapshot(asset);
    }
    return null;
  } catch {
    return null;
  }
}

function contextCheckCounts(snapshot: MarketSnapshot | null, assetType: DebugAssetType): {
  newsChecked: boolean;
  newsCount: number;
  macroChecked: boolean;
  macroCount: number;
} {
  if (!snapshot) {
    return {
      newsChecked: assetType === "equity",
      newsCount: 0,
      macroChecked: assetType === "forex" || assetType === "commodity",
      macroCount: 0
    };
  }

  if (snapshot.assetClass === "equity") {
    return {
      newsChecked: true,
      newsCount: snapshot.latestNews.length,
      macroChecked: false,
      macroCount: 0
    };
  }

  if (snapshot.assetClass === "forex") {
    return {
      newsChecked: false,
      newsCount: 0,
      macroChecked: true,
      macroCount: [snapshot.dxyContext, snapshot.yieldContext, snapshot.centralBankContext].filter((context) => context.sourceId).length + snapshot.macroEvents.length
    };
  }

  return {
    newsChecked: false,
    newsCount: 0,
    macroChecked: true,
    macroCount: [
      snapshot.dollarContext,
      snapshot.yieldContext,
      snapshot.inventoryContext,
      snapshot.supplyDemandContext,
      snapshot.geopoliticalContext
    ].filter((context) => context.sourceId).length
  };
}

function debugFallbackReason(input: {
  quoteFound: boolean;
  assetType: DebugAssetType;
  snapshotFound: boolean;
  aiStatus: ReturnType<AnalysisPipeline["getAiStatus"]>;
  geminiDailyLimitReached: boolean;
}): string | null {
  if (!input.quoteFound) {
    return "quote data unavailable";
  }
  if (input.assetType === "index") {
    return "index debug does not generate analyst commentary";
  }
  if (input.aiStatus.provider.toLowerCase() !== "gemini") {
    return `AI provider is ${input.aiStatus.provider}`;
  }
  if (!(input.aiStatus.geminiConfigured ?? input.aiStatus.configured)) {
    return "Gemini is not configured";
  }
  if (!input.snapshotFound) {
    return "snapshot context could not be assembled";
  }
  if (input.geminiDailyLimitReached) {
    return "daily Gemini generation limit reached";
  }
  return null;
}

function sanitizeDebugMessage(message: string): string {
  return message
    .replace(/(apikey|api_key|token|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-google-api-key]")
    .slice(0, 300);
}

function corsOrigins(): string[] | undefined {
  return process.env.CORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
