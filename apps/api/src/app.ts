import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  AnalysisPipeline,
  createAnalystWriterFromEnv
} from "@market-desk/analysis-engine";
import { ComplianceEngine } from "@market-desk/compliance";
import { MarketSnapshotService, SnapshotNotFoundError } from "@market-desk/core";
import { createMockProviderBundle, createProviderBundleFromEnv, detectAssetType, ProviderBundle } from "@market-desk/data-providers";
import { analysisModeSchema } from "@market-desk/shared";
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

  app.get("/debug/provider/:asset", { preHandler: requireRole(["viewer", "analyst", "admin"]) }, async (request) => {
    const params = z.object({ asset: z.string().min(1) }).parse(request.params);
    const query = z.object({ refresh: z.coerce.boolean().optional() }).parse(request.query);
    const assetType = detectAssetType(params.asset);
    const providerWithDebug = services.providers.marketData as unknown as {
      debugAsset?: (asset: string, refresh?: boolean) => Promise<Record<string, unknown>>;
    };
    if (providerWithDebug.debugAsset) {
      return providerWithDebug.debugAsset(params.asset, query.refresh ?? false);
    }

    const quote =
      assetType === "forex"
        ? await services.providers.marketData.getForexQuote(params.asset)
        : assetType === "commodity"
          ? await services.providers.marketData.getCommodityQuote(params.asset)
          : assetType === "index"
            ? await services.providers.marketData.getIndexMove(params.asset)
            : await services.providers.marketData.getEquityQuote(params.asset);
    return {
      requestedAsset: params.asset,
      detectedAssetType: assetType,
      selectedProvider: process.env.MARKET_DATA_PROVIDER ?? "provider_router",
      normalizedSymbol: quote?.providerSymbol ?? quote?.symbol,
      providerRequestStatus: quote ? "ok" : "not_found",
      sanitizedData: quote
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
        : null,
      sourceTimestamps: quote?.asOf ? [quote.asOf] : [],
      providerErrors: services.providers.health?.getProviderHealth().map((item) => item.message).filter(Boolean) ?? []
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

function corsOrigins(): string[] | undefined {
  return process.env.CORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
