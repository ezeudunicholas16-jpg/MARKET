import { ProviderBundle } from "@market-desk/data-providers";
import {
  CommoditySnapshot,
  EquitySnapshot,
  ForexSnapshot,
  MacroContext,
  MacroEvent,
  NewsItem,
  FilingRecord,
  EarningsContext,
  MarketSnapshot,
  SourceRecord,
  normalizeSymbol,
  nowIso
} from "@market-desk/shared";

export class SnapshotNotFoundError extends Error {
  constructor(symbol: string, assetClass: string) {
    super(`No ${assetClass} snapshot data available for ${symbol}`);
    this.name = "SnapshotNotFoundError";
  }
}

export class MarketSnapshotService {
  constructor(private readonly providers: ProviderBundle) {}

  async getEquitySnapshot(symbolInput: string): Promise<EquitySnapshot> {
    const symbol = normalizeSymbol(symbolInput);
    const quote = await this.providers.marketData.getEquityQuote(symbol);
    if (!quote) {
      throw new SnapshotNotFoundError(symbol, "equity");
    }

    const sector = (await optionalValue(() => this.providers.sector.getSectorForSymbol(symbol), null)) ?? "Unknown";
    const [sectorMove, indexQuote, latestNews, latestFilings, earningsContext] = await Promise.all([
      optionalValue(() => this.providers.sector.getSectorPerformance(sector), 0),
      optionalValue(() => this.providers.marketData.getIndexMove(symbol === "NVDA" ? "QQQ" : "SPY"), null),
      optionalArray<NewsItem>(() => this.providers.news.getLatestNews({ symbol, assetClass: "equity", limit: 5 })),
      optionalArray<FilingRecord>(() => this.providers.filings.getLatestFilings(symbol)),
      optionalValue<EarningsContext | null>(() => this.providers.earnings.getEarningsContext(symbol), null)
    ]);

    const sourceIds = [
      quote.sourceId,
      quote.isStale ? "src-live-source-warning" : undefined,
      indexQuote?.sourceId,
      indexQuote?.isStale ? "src-live-source-warning" : undefined,
      ...latestNews.map((item) => item.sourceId),
      ...latestFilings.map((item) => item.sourceId),
      earningsContext?.sourceId
    ].filter((item): item is string => Boolean(item));

    return {
      assetClass: "equity",
      symbol,
      normalizedSymbol: quote.providerSymbol ?? symbol,
      price: quote.price,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      percentChange: quote.percentChange,
      volume: quote.volume ?? 0,
      relativeVolume: quote.relativeVolume ?? null,
      sourceName: quote.sourceName,
      sourceTime: quote.asOf,
      providerSymbol: quote.providerSymbol,
      providerStatus: quote.providerStatus,
      sector,
      sectorMove,
      indexMove: indexQuote?.percentChange ?? 0,
      latestNews,
      latestFilings,
      earningsContext,
      detectedCatalysts: [],
      generatedAt: nowIso(),
      sources: await this.sources(sourceIds)
    };
  }

  async getForexSnapshot(pairInput: string): Promise<ForexSnapshot> {
    const pair = normalizeSymbol(pairInput);
    const quote = await this.providers.marketData.getForexQuote(pair);
    if (!quote) {
      throw new SnapshotNotFoundError(pair, "forex");
    }

    const [dxyContext, yieldContext, centralBankContext, macroEvents] = await Promise.all([
      optionalValue(() => this.providers.macro.getDxyContext(), unavailableContext("DXY", "DXY context unavailable.")),
      optionalValue(() => this.providers.macro.getYieldContext(), unavailableContext("U.S. yields", "Yield context unavailable.")),
      optionalValue(() => this.providers.macro.getCentralBankContext(pair), unavailableContext(`${pair} central-bank context`, "Central-bank context unavailable.")),
      optionalArray<MacroEvent>(() => this.providers.macro.getMacroEvents("forex"))
    ]);

    const sourceIds = [
      quote.sourceId,
      quote.isStale ? "src-live-source-warning" : undefined,
      dxyContext.sourceId,
      yieldContext.sourceId,
      centralBankContext.sourceId,
      ...macroEvents.map((event) => event.sourceId)
    ].filter((item): item is string => Boolean(item));

    return {
      assetClass: "forex",
      pair,
      normalizedSymbol: quote.providerSymbol ?? pair,
      price: quote.price,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      percentChange: quote.percentChange,
      sourceName: quote.sourceName,
      sourceTime: quote.asOf,
      providerSymbol: quote.providerSymbol,
      providerStatus: quote.providerStatus,
      dxyContext,
      yieldContext,
      centralBankContext,
      macroEvents,
      detectedCatalysts: [],
      generatedAt: nowIso(),
      sources: await this.sources(sourceIds)
    };
  }

  async getCommoditySnapshot(assetInput: string): Promise<CommoditySnapshot> {
    const asset = normalizeSymbol(assetInput);
    const quote = await this.providers.marketData.getCommodityQuote(asset);
    if (!quote) {
      throw new SnapshotNotFoundError(asset, "commodity");
    }

    const [dollarContext, yieldContext, inventoryContext, supplyDemandContext, geopoliticalContext] =
      await Promise.all([
        optionalValue(() => this.providers.macro.getDxyContext(), unavailableContext("DXY", "DXY context unavailable.")),
        optionalValue(() => this.providers.macro.getYieldContext(), unavailableContext("U.S. yields", "Yield context unavailable.")),
        optionalValue(() => this.providers.macro.getInventoryContext(asset), unavailableContext(`${asset} inventory context`, "Inventory context unavailable.")),
        optionalValue(() => this.providers.macro.getSupplyDemandContext(asset), unavailableContext(`${asset} supply-demand context`, "Supply-demand context unavailable.")),
        optionalValue(() => this.providers.macro.getGeopoliticalContext(asset), unavailableContext(`${asset} geopolitical context`, "Geopolitical context unavailable."))
      ]);

    const sourceIds = [
      quote.sourceId,
      quote.isStale ? "src-live-source-warning" : undefined,
      dollarContext.sourceId,
      yieldContext.sourceId,
      inventoryContext.sourceId,
      supplyDemandContext.sourceId,
      geopoliticalContext.sourceId
    ].filter((item): item is string => Boolean(item));

    return {
      assetClass: "commodity",
      asset,
      normalizedSymbol: quote.providerSymbol ?? asset,
      price: quote.price,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      percentChange: quote.percentChange,
      sourceName: quote.sourceName,
      sourceTime: quote.asOf,
      providerSymbol: quote.providerSymbol,
      providerStatus: quote.providerStatus,
      dollarContext,
      yieldContext,
      inventoryContext,
      supplyDemandContext,
      geopoliticalContext,
      detectedCatalysts: [],
      generatedAt: nowIso(),
      sources: await this.sources(sourceIds)
    };
  }

  async getSnapshot(input: { assetClass: "equity"; symbol: string }): Promise<EquitySnapshot>;
  async getSnapshot(input: { assetClass: "forex"; symbol: string }): Promise<ForexSnapshot>;
  async getSnapshot(input: { assetClass: "commodity"; symbol: string }): Promise<CommoditySnapshot>;
  async getSnapshot(input: { assetClass: MarketSnapshot["assetClass"]; symbol: string }): Promise<MarketSnapshot> {
    if (input.assetClass === "forex") {
      return this.getForexSnapshot(input.symbol);
    }
    if (input.assetClass === "commodity") {
      return this.getCommoditySnapshot(input.symbol);
    }
    return this.getEquitySnapshot(input.symbol);
  }

  private async sources(sourceIds: string[]): Promise<SourceRecord[]> {
    const uniqueIds = [...new Set(sourceIds)];
    try {
      const sources = await this.providers.sources.getSourcesByIds(uniqueIds);
      const existing = new Set(sources.map((source) => source.id));
      return [
        ...sources,
        ...uniqueIds.filter((id) => !existing.has(id)).map((id) => fallbackSource(id))
      ];
    } catch {
      return uniqueIds.map((id) => fallbackSource(id));
    }
  }
}

async function optionalValue<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

async function optionalArray<T>(call: () => Promise<T[]>): Promise<T[]> {
  try {
    return await call();
  } catch {
    return [];
  }
}

function unavailableContext(label: string, value: string): MacroContext {
  return {
    label,
    value,
    bias: "neutral",
    asOf: nowIso(),
    sourceId: undefined
  };
}

function fallbackSource(id: string): SourceRecord {
  return {
    id,
    provider: id.includes("twelve") ? "twelve_data" : "provider-router",
    type: id.includes("warning") ? "internal" : "market_data",
    title: id.includes("warning") ? "Optional live source warning" : `Live source ${id}`,
    retrievedAt: nowIso(),
    credibilityScore: id.includes("warning") ? 100 : 75
  };
}
