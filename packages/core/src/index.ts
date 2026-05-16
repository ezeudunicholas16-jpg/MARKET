import { ProviderBundle } from "@market-desk/data-providers";
import {
  CommoditySnapshot,
  EquitySnapshot,
  ForexSnapshot,
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

    const sector = (await this.providers.sector.getSectorForSymbol(symbol)) ?? "Unknown";
    const [sectorMove, indexQuote, latestNews, latestFilings, earningsContext] = await Promise.all([
      this.providers.sector.getSectorPerformance(sector),
      this.providers.marketData.getIndexMove(symbol === "NVDA" ? "QQQ" : "SPY"),
      this.providers.news.getLatestNews({ symbol, assetClass: "equity", limit: 5 }),
      this.providers.filings.getLatestFilings(symbol),
      this.providers.earnings.getEarningsContext(symbol)
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
      this.providers.macro.getDxyContext(),
      this.providers.macro.getYieldContext(),
      this.providers.macro.getCentralBankContext(pair),
      this.providers.macro.getMacroEvents("forex")
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
        this.providers.macro.getDxyContext(),
        this.providers.macro.getYieldContext(),
        this.providers.macro.getInventoryContext(asset),
        this.providers.macro.getSupplyDemandContext(asset),
        this.providers.macro.getGeopoliticalContext(asset)
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
    return this.providers.sources.getSourcesByIds(uniqueIds);
  }
}
