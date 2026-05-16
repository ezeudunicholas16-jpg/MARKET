import { AnalysisPipeline, AnalysisResult } from "@market-desk/analysis-engine";
import { ComplianceEngine, ensurePublicDisclaimer } from "@market-desk/compliance";
import { MarketDataProvider, ProviderHealthReporter, ProviderHealthStatus } from "@market-desk/data-providers";
import { TelegramClient, ParsedTelegramCommand } from "@market-desk/telegram";
import { PublishingService } from "./publishing";

export interface CommandContext {
  pipeline: AnalysisPipeline;
  marketData: MarketDataProvider;
  compliance: ComplianceEngine;
  telegram: TelegramClient;
  publishing: PublishingService;
  providerHealth?: ProviderHealthReporter;
}

export interface CommandResult {
  text: string;
  status: "ok" | "error";
  sentToTelegram?: boolean;
}

export async function handleTelegramCommand(
  parsed: ParsedTelegramCommand,
  context: CommandContext,
  _chatId?: number | string
): Promise<CommandResult> {
  try {
    switch (parsed.command) {
      case "/market":
        return { status: "ok", text: await marketBrief(context) };
      case "/why":
        return {
          status: "ok",
          text: analysisBody(await context.pipeline.analyzeEquity(requiredArg(parsed, "SYMBOL"), "equity_mover_reaction"))
        };
      case "/forex":
        return {
          status: "ok",
          text: analysisBody(await context.pipeline.analyzeForex(requiredArg(parsed, "PAIR"), "forex_reaction"))
        };
      case "/commodity":
        return {
          status: "ok",
          text: analysisBody(await context.pipeline.analyzeCommodity(requiredArg(parsed, "ASSET"), "commodity_reaction"))
        };
      case "/movers":
        return { status: "ok", text: await moversText(context.marketData) };
      case "/research":
        return {
          status: "ok",
          text: researchText(await context.pipeline.analyzeEquity(requiredArg(parsed, "SYMBOL"), "private_research"))
        };
      case "/post": {
        const record = await context.publishing.createDraft({
          symbol: requiredArg(parsed, "SYMBOL"),
          assetClass: "equity",
          mode: "equity_mover_reaction"
        });
        return {
          status: "ok",
          sentToTelegram: record.status === "auto_posted",
          text: [
            `Publishing decision: ${record.decision.status}`,
            `Draft status: ${record.status}`,
            record.decision.reasons.join("\n"),
            "",
            record.result.draft.body
          ].join("\n")
        };
      }
      case "/riskcheck":
        return {
          status: "ok",
          text: riskcheckText(context.compliance.review(parsed.rawArgs, { publicOutput: true, sourceCount: 1 }))
        };
      case "/status":
        return { status: "ok", text: statusText(context) };
      default:
        return {
          status: "error",
          text: "Unknown command. Supported: /market, /why SYMBOL, /forex EURUSD, /commodity GOLD, /movers, /research SYMBOL, /post SYMBOL, /riskcheck TEXT, /status"
        };
    }
  } catch (error) {
    return {
      status: "error",
      text: error instanceof Error ? error.message : "Command failed."
    };
  }
}

function statusText(context: CommandContext): string {
  const ai = context.pipeline.getAiStatus();
  const health = context.providerHealth?.getProviderHealth() ?? [];
  const requiredProviderErrorCount = requiredProviderErrors(health);
  const optionalWarnings = optionalSourceWarnings(health);
  const lastProviderError = latestProviderError(health);
  const lastOptionalWarning = latestOptionalSourceWarning(health);
  return [
    "Market Desk Engine is online.",
    `Render/public URL: ${process.env.API_PUBLIC_URL || "not configured"}`,
    `Live data enabled: ${process.env.LIVE_DATA_ENABLED === "true"}`,
    `Market provider: ${providerLabel(process.env.MARKET_DATA_PROVIDER ?? process.env.MARKET_DATA_PRIMARY_PROVIDER)}`,
    `Forex provider: ${providerLabel(process.env.FOREX_PROVIDER ?? process.env.MARKET_DATA_PROVIDER)}`,
    `Commodity provider: ${providerLabel(process.env.COMMODITY_PROVIDER ?? process.env.MARKET_DATA_PROVIDER)}`,
    `Index provider: ${providerLabel(process.env.INDEX_PROVIDER ?? process.env.MARKET_DATA_PROVIDER)}`,
    `News provider: Finnhub configured ${Boolean(process.env.FINNHUB_API_KEY)}`,
    `Macro provider: FRED configured ${Boolean(process.env.FRED_API_KEY)}`,
    `Filings provider: SEC configured ${Boolean(process.env.SEC_USER_AGENT)}`,
    `AI provider: ${ai.provider}`,
    `Model: ${ai.model}`,
    `Fallback: ${ai.fallbackProvider}`,
    `Gemini configured: ${ai.geminiConfigured ?? ai.configured}`,
    `Today's AI attempted calls: ${ai.todayAttemptedAiCalls}/${Number.isFinite(ai.maxGenerationsPerDay) ? ai.maxGenerationsPerDay : "unlimited"}`,
    `Today's successful AI calls: ${ai.todaySuccessfulAiCalls}`,
    `Today's fallback count: ${ai.todayFallbackCount}`,
    `Last AI provider used: ${ai.lastProviderUsed ?? "none"}`,
    `Last AI provider attempted: ${ai.lastProviderAttempted ?? "none"}`,
    `Last AI call attempted: ${ai.lastCallAttempted ?? false}`,
    `Last Gemini success: ${ai.lastGeminiSuccess ?? false}`,
    `Last Gemini raw response usable: ${ai.lastGeminiRawResponseUsable ?? false}`,
    `Last Gemini JSON parse recovered: ${ai.lastGeminiJsonParseRecovered ?? false}`,
    `Last Gemini response mode: ${ai.lastGeminiResponseMode ?? "text"}`,
    `Last original Gemini quality passed: ${ai.lastOriginalGeminiQualityPassed ?? false}`,
    `Last quality check passed: ${ai.lastQualityCheckPassed ?? false}`,
    `Last rewrite attempted: ${ai.lastQualityRewriteAttempted ?? false}`,
    `Last rewrite quality passed: ${ai.lastQualityRewritePassed ?? false}`,
    `Last final writer used: ${ai.lastFinalWriterUsed ?? "none"}`,
    `Last AI fallback reason: ${ai.lastFallbackReason ?? "none"}`,
    `Last Gemini error: ${ai.lastGeminiError ?? "none"}`,
    `Required quote provider errors: ${requiredProviderErrorCount}`,
    `Optional source warnings: ${optionalWarnings}`,
    `Last optional source warning: ${lastOptionalWarning ?? "none"}`,
    `Last provider error name: ${lastProviderError?.lastErrorName ?? "none"}`,
    `Last provider error message: ${lastProviderError?.message ? sanitizeStatusMessage(lastProviderError.message) : "none"}`,
    `Last provider endpoint/category: ${lastProviderError?.endpointCategory ?? "none"}`,
    `Required provider error counts: ${providerErrorCounts(health)}`,
    `Publishing mode: ${process.env.PUBLISHING_MODE ?? "approval_required"}`,
    `Scheduler status: ${process.env.ENABLE_SCHEDULER === "true" ? "enabled" : "paused"}`
  ].join("\n");
}

function latestProviderError(health: ProviderHealthStatus[]): ProviderHealthStatus | undefined {
  return health
    .filter((item) => item.category === "market_data" && (item.failedRequestCount > 0 || item.status === "down"))
    .sort((a, b) => Date.parse(b.lastFailedRequestAt ?? "") - Date.parse(a.lastFailedRequestAt ?? ""))
    .at(0);
}

function providerErrorCounts(health: ProviderHealthStatus[]): string {
  const counts = health
    .filter((item) => item.category === "market_data" && item.failedRequestCount > 0)
    .map((item) => `${item.providerId}=${item.failedRequestCount}`);
  return counts.length ? counts.join(", ") : "none";
}

function requiredProviderErrors(health: ProviderHealthStatus[]): number {
  return health
    .filter((item) => item.category === "market_data")
    .reduce((total, item) => total + item.failedRequestCount, 0);
}

function optionalSourceWarnings(health: ProviderHealthStatus[]): number {
  return health.reduce((total, item) => {
    if (item.category === "market_data") {
      return total;
    }
    return total + (item.optionalSourceWarningCount ?? 0) + item.failedRequestCount;
  }, 0);
}

function latestOptionalSourceWarning(health: ProviderHealthStatus[]): string | undefined {
  const warnings = health
    .filter((item) => item.category !== "market_data")
    .map((item) => item.lastOptionalSourceWarning ?? item.message)
    .filter((warning): warning is string => Boolean(warning))
    .filter((warning) => !/healthy/i.test(warning));
  return warnings.at(-1);
}

function sanitizeStatusMessage(message: string): string {
  return message
    .replace(/(apikey|api_key|token|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-google-api-key]")
    .slice(0, 300);
}

function requiredArg(parsed: ParsedTelegramCommand, label: string): string {
  const value = parsed.args[0];
  if (!value) {
    throw new Error(`Missing required argument: ${label}`);
  }
  return value;
}

function analysisBody(result: AnalysisResult): string {
  return result.draft.body;
}

function researchText(result: AnalysisResult): string {
  return [
    result.draft.title,
    result.draft.body,
    `Confidence: ${result.draft.confidence.score}/100 (${result.draft.confidence.band})`,
    `Catalyst: ${result.draft.catalyst.classification}`,
    `Sources: ${result.draft.sourcesUsed.join(", ") || "none"}`
  ].join("\n\n");
}

async function moversText(provider: MarketDataProvider): Promise<string> {
  const movers = await provider.getMovers(6);
  if (movers.length === 0) {
    return ensurePublicDisclaimer("No live movers were available from the configured provider. Check /status or /health/providers for provider configuration.");
  }
  const lines = movers.map(
    (quote, index) =>
      `${index + 1}. ${quote.symbol}: ${formatSignedPercent(quote.percentChange)} (${quote.assetClass})`
  );
  return ensurePublicDisclaimer(["Top live movers", ...lines].join("\n"));
}

async function marketBrief(context: CommandContext): Promise<string> {
  const movers = await context.marketData.getMovers(8);
  const strongest = movers.find((quote) => quote.assetClass !== "index") ?? movers[0];

  if (!strongest) {
    return ensurePublicDisclaimer(
      "Market brief: no live movers were available from the configured provider. Check provider configuration before publishing commentary."
    );
  }

  const topMoverLines = movers.slice(0, 5).map((quote) => `${quote.symbol} ${formatSignedPercent(quote.percentChange)}`);
  const draft =
    strongest.assetClass === "forex"
      ? await context.pipeline.analyzeForex(strongest.symbol, "forex_reaction")
      : strongest.assetClass === "commodity"
        ? await context.pipeline.analyzeCommodity(strongest.symbol, "commodity_reaction")
        : strongest.assetClass === "equity"
          ? await context.pipeline.analyzeEquity(strongest.symbol, "equity_mover_reaction")
          : null;

  if (!draft) {
    return ensurePublicDisclaimer(
      [
        `Market brief: ${strongest.symbol} is the largest monitored mover at ${formatSignedPercent(strongest.percentChange)}.`,
        `Top monitored moves: ${topMoverLines.join(", ")}.`
      ].join("\n\n")
    );
  }

  return ensurePublicDisclaimer(
    [stripPublicDisclaimer(draft.draft.body), `Top monitored moves: ${topMoverLines.join(", ")}.`].join("\n\n")
  );
}

function stripPublicDisclaimer(text: string): string {
  return text.replace(/\s*Market commentary only\.\s*$/i, "").trim();
}

function providerLabel(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "twelve_data") {
    return "Twelve Data";
  }
  return value || "not configured";
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function riskcheckText(result: ReturnType<ComplianceEngine["review"]>): string {
  const flagText = result.flags.length
    ? result.flags.map((flag) => `- ${flag.code}: ${flag.phrase}`).join("\n")
    : "No compliance flags.";
  return [`Status: ${result.status}`, flagText, "Neutral version:", result.finalText || "[blocked]"].join("\n\n");
}
