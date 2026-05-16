import {
  AnalysisMode,
  CatalystCandidate,
  ConfidenceResult,
  MarketSnapshot,
  normalizeSymbol
} from "@market-desk/shared";
import { AnalystPromptInput, analystPromptInputSchema } from "./schemas";
import { getAnalystPromptDefinition } from "./registry";

export interface BuildPromptInputArgs {
  mode: AnalysisMode;
  snapshot: MarketSnapshot;
  catalysts: CatalystCandidate[];
  confidence: ConfidenceResult;
}

export function buildAnalystPromptInput(args: BuildPromptInputArgs): AnalystPromptInput {
  const primaryCatalyst = args.catalysts[0];
  if (!primaryCatalyst) {
    throw new Error("Cannot build analyst prompt input without a catalyst.");
  }

  const definition = getAnalystPromptDefinition(args.mode);
  const sourceById = new Map(args.snapshot.sources.map((source) => [source.id, source]));
  const evidence = primaryCatalyst.evidence.map((item) => {
    const source = sourceById.get(item.sourceId);
    return {
      ...item,
      sourceTitle: source?.title,
      sourceType: source?.type
    };
  });

  return analystPromptInputSchema.parse({
    mode: args.mode,
    subject: snapshotSubject(args.snapshot),
    assetClass: args.snapshot.assetClass,
    snapshot: args.snapshot,
    primaryCatalyst,
    catalysts: args.catalysts,
    confidence: args.confidence,
    evidence,
    sources: args.snapshot.sources,
    facts: snapshotFacts(args.snapshot),
    publicFooter: definition.publicOutput ? "Market commentary only." : undefined,
    styleInstruction: definition.systemPrompt
  });
}

export function snapshotSubject(snapshot: MarketSnapshot): string {
  if (snapshot.assetClass === "equity") {
    return normalizeSymbol(snapshot.symbol);
  }
  if (snapshot.assetClass === "forex") {
    return normalizeSymbol(snapshot.pair);
  }
  return normalizeSymbol(snapshot.asset);
}

export function snapshotMove(snapshot: MarketSnapshot): number {
  return snapshot.percentChange;
}

export function formatMove(percentChange: number): string {
  const direction = percentChange >= 0 ? "firmer" : "softer";
  return `${direction} by ${Math.abs(percentChange).toFixed(2)}%`;
}

function snapshotFacts(snapshot: MarketSnapshot): string[] {
  if (snapshot.assetClass === "equity") {
    return [
      `${snapshot.symbol} is ${formatMove(snapshot.percentChange)}.`,
      `Volume is ${snapshot.volume.toLocaleString()}${snapshot.relativeVolume ? ` with relative volume at ${snapshot.relativeVolume.toFixed(2)}x` : ""}.`,
      `${snapshot.sector} sector move is ${signedPercent(snapshot.sectorMove)}.`,
      `Index context is ${signedPercent(snapshot.indexMove)}.`,
      ...snapshot.latestNews.map((item) => `News: ${item.headline}`),
      ...snapshot.latestFilings.map((item) => `Filing: ${item.filingType} - ${item.title}`),
      snapshot.earningsContext?.guidance ? `Earnings context: ${snapshot.earningsContext.guidance}` : ""
    ].filter(Boolean);
  }

  if (snapshot.assetClass === "forex") {
    return [
      `${snapshot.pair} is ${formatMove(snapshot.percentChange)}.`,
      `${snapshot.dxyContext.label}: ${snapshot.dxyContext.value}`,
      `${snapshot.yieldContext.label}: ${snapshot.yieldContext.value}`,
      `${snapshot.centralBankContext.label}: ${snapshot.centralBankContext.value}`,
      ...snapshot.macroEvents.map(
        (event) =>
          `Macro event: ${event.name}, consensus ${event.consensus ?? "n/a"}, prior ${event.prior ?? "n/a"}.`
      )
    ];
  }

  return [
    `${snapshot.asset} is ${formatMove(snapshot.percentChange)}.`,
    `${snapshot.dollarContext.label}: ${snapshot.dollarContext.value}`,
    `${snapshot.yieldContext.label}: ${snapshot.yieldContext.value}`,
    `${snapshot.inventoryContext.label}: ${snapshot.inventoryContext.value}`,
    `${snapshot.supplyDemandContext.label}: ${snapshot.supplyDemandContext.value}`,
    `${snapshot.geopoliticalContext.label}: ${snapshot.geopoliticalContext.value}`
  ];
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
