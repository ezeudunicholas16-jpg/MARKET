import { AnalysisPipeline, AnalysisResult } from "@market-desk/analysis-engine";
import { ComplianceEngine, ensurePublicDisclaimer } from "@market-desk/compliance";
import { MarketDataProvider } from "@market-desk/data-providers";
import { TelegramClient, ParsedTelegramCommand } from "@market-desk/telegram";
import { PublishingService } from "./publishing";

export interface CommandContext {
  pipeline: AnalysisPipeline;
  marketData: MarketDataProvider;
  compliance: ComplianceEngine;
  telegram: TelegramClient;
  publishing: PublishingService;
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
        return { status: "ok", text: await marketBrief(context.marketData) };
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
        return { status: "ok", text: statusText(context.pipeline) };
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

function statusText(pipeline: AnalysisPipeline): string {
  const ai = pipeline.getAiStatus();
  return [
    "Market Desk Engine is online.",
    `AI provider: ${ai.provider}`,
    `Model: ${ai.model}`,
    `Fallback: ${ai.fallbackProvider}`,
    `Today's AI calls: ${ai.todayAiCalls}/${Number.isFinite(ai.maxGenerationsPerDay) ? ai.maxGenerationsPerDay : "unlimited"}`,
    `Today's fallback count: ${ai.todayFallbackCount}`,
    "Providers: configured through provider router. Scheduler: optional."
  ].join("\n");
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
  const lines = movers.map(
    (quote, index) =>
      `${index + 1}. ${quote.symbol}: ${quote.percentChange >= 0 ? "+" : ""}${quote.percentChange.toFixed(2)}%`
  );
  return ensurePublicDisclaimer(["Top mock movers", ...lines].join("\n"));
}

async function marketBrief(provider: MarketDataProvider): Promise<string> {
  const movers = await provider.getMovers(5);
  const strongest = movers[0];
  const body = strongest
    ? `Global mock brief: ${strongest.symbol} is the largest monitored mover at ${strongest.percentChange >= 0 ? "+" : ""}${strongest.percentChange.toFixed(2)}%. Source coverage remains mock-only until live providers are configured.`
    : "Global mock brief: no movers available from provider feed.";
  return ensurePublicDisclaimer(body);
}

function riskcheckText(result: ReturnType<ComplianceEngine["review"]>): string {
  const flagText = result.flags.length
    ? result.flags.map((flag) => `- ${flag.code}: ${flag.phrase}`).join("\n")
    : "No compliance flags.";
  return [`Status: ${result.status}`, flagText, "Neutral version:", result.finalText || "[blocked]"].join("\n\n");
}
