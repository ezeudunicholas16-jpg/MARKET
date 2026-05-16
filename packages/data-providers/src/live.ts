import {
  AssetClass,
  EarningsContext,
  FilingRecord,
  MacroContext,
  MacroEvent,
  NewsItem,
  Quote,
  SourceRecord,
  normalizeSymbol,
  nowIso
} from "@market-desk/shared";
import type {
  EarningsProvider,
  FilingsProvider,
  MacroProvider,
  MarketDataProvider,
  NewsProvider,
  ProviderBundle,
  SectorProvider,
  SourceProvider
} from "./index";

export type ProviderCategory =
  | "market_data"
  | "news"
  | "macro"
  | "filings"
  | "earnings"
  | "sector"
  | "sources"
  | "mock";

export type RateLimitStatus = "ok" | "limited" | "unknown";
export type ProviderRuntimeStatus = "ok" | "degraded" | "down" | "disabled";

export interface ProviderHealthStatus {
  providerId: string;
  providerName: string;
  category: ProviderCategory;
  configured: boolean;
  enabled: boolean;
  lastSuccessfulRequestAt?: string;
  lastFailedRequestAt?: string;
  failedRequestCount: number;
  rateLimitStatus: RateLimitStatus;
  rateLimitResetAt?: string;
  staleDataWarning: boolean;
  status: ProviderRuntimeStatus;
  message?: string;
}

export interface ProviderHealthReporter {
  getProviderHealth(): ProviderHealthStatus[];
}

export interface ProviderFactoryEnv {
  NODE_ENV?: string;
  MARKET_DATA_PRIMARY_PROVIDER?: string;
  MARKET_DATA_BACKUP_PROVIDER?: string;
  NEWS_PRIMARY_PROVIDER?: string;
  NEWS_BACKUP_PROVIDER?: string;
  MACRO_PRIMARY_PROVIDER?: string;
  MACRO_BACKUP_PROVIDER?: string;
  FILINGS_PRIMARY_PROVIDER?: string;
  FILINGS_BACKUP_PROVIDER?: string;
  EARNINGS_PRIMARY_PROVIDER?: string;
  EARNINGS_BACKUP_PROVIDER?: string;
  SECTOR_PRIMARY_PROVIDER?: string;
  SECTOR_BACKUP_PROVIDER?: string;
  ALLOW_MOCK_PROVIDER_FALLBACK?: string;
  FMP_API_KEY?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  SEC_USER_AGENT?: string;
}

const LIVE_WARNING_SOURCE: SourceRecord = {
  id: "src-live-source-warning",
  provider: "provider-router",
  type: "internal",
  title: "There is no clean confirmed catalyst from available live sources at the time of writing.",
  retrievedAt: nowIso(),
  credibilityScore: 100
};

export class ProviderReliabilityTracker implements ProviderHealthReporter {
  private lastSuccessfulRequestAt?: string;
  private lastFailedRequestAt?: string;
  private failedRequestCount = 0;
  private rateLimitStatus: RateLimitStatus = "unknown";
  private rateLimitResetAt?: string;
  private staleDataWarning = false;
  private message?: string;

  constructor(
    private readonly input: {
      providerId: string;
      providerName: string;
      category: ProviderCategory;
      configured: boolean;
      enabled?: boolean;
      staleAfterMs?: number;
    }
  ) {}

  recordSuccess(dataAsOf?: string): void {
    this.lastSuccessfulRequestAt = nowIso();
    this.rateLimitStatus = "ok";
    this.message = undefined;
    this.staleDataWarning = dataAsOf ? isOlderThan(dataAsOf, this.input.staleAfterMs ?? 30 * 60 * 1000) : false;
  }

  recordFailure(error: unknown): void {
    this.lastFailedRequestAt = nowIso();
    this.failedRequestCount += 1;
    this.message = error instanceof Error ? error.message : String(error);
  }

  recordRateLimit(resetAt?: string): void {
    this.rateLimitStatus = "limited";
    this.rateLimitResetAt = resetAt;
    this.recordFailure("Provider rate limit reached.");
  }

  recordStale(message = "Provider returned stale data."): void {
    this.staleDataWarning = true;
    this.message = message;
  }

  getProviderHealth(): ProviderHealthStatus[] {
    const enabled = this.input.enabled ?? true;
    const status: ProviderRuntimeStatus = !enabled
      ? "disabled"
      : !this.input.configured
        ? "disabled"
        : this.rateLimitStatus === "limited" || this.staleDataWarning || this.failedRequestCount > 0
          ? "degraded"
          : this.lastSuccessfulRequestAt
            ? "ok"
            : "degraded";

    return [
      {
        providerId: this.input.providerId,
        providerName: this.input.providerName,
        category: this.input.category,
        configured: this.input.configured,
        enabled,
        lastSuccessfulRequestAt: this.lastSuccessfulRequestAt,
        lastFailedRequestAt: this.lastFailedRequestAt,
        failedRequestCount: this.failedRequestCount,
        rateLimitStatus: this.rateLimitStatus,
        rateLimitResetAt: this.rateLimitResetAt,
        staleDataWarning: this.staleDataWarning,
        status,
        message: this.message
      }
    ];
  }
}

export class LiveSourceRegistry implements SourceProvider, ProviderHealthReporter {
  private readonly sources = new Map<string, SourceRecord>([[LIVE_WARNING_SOURCE.id, LIVE_WARNING_SOURCE]]);
  private readonly healthReporters: ProviderHealthReporter[] = [];

  registerSource(source: SourceRecord): SourceRecord {
    this.sources.set(source.id, source);
    return source;
  }

  registerHealthReporter(reporter: ProviderHealthReporter): void {
    this.healthReporters.push(reporter);
  }

  async getSourcesByIds(ids: string[]): Promise<SourceRecord[]> {
    return ids.map((id) => this.sources.get(id)).filter((source): source is SourceRecord => Boolean(source));
  }

  async getAllSources(): Promise<SourceRecord[]> {
    return [...this.sources.values()];
  }

  getProviderHealth(): ProviderHealthStatus[] {
    return this.healthReporters.flatMap((reporter) => reporter.getProviderHealth());
  }
}

abstract class HttpProviderBase implements ProviderHealthReporter {
  protected readonly reliability: ProviderReliabilityTracker;

  protected constructor(
    protected readonly registry: LiveSourceRegistry,
    input: {
      providerId: string;
      providerName: string;
      category: ProviderCategory;
      apiKey?: string;
      enabled?: boolean;
      staleAfterMs?: number;
    }
  ) {
    this.reliability = new ProviderReliabilityTracker({
      providerId: input.providerId,
      providerName: input.providerName,
      category: input.category,
      configured: Boolean(input.apiKey) || input.providerId === "sec",
      enabled: input.enabled,
      staleAfterMs: input.staleAfterMs
    });
    this.registry.registerHealthReporter(this);
  }

  getProviderHealth(): ProviderHealthStatus[] {
    return this.reliability.getProviderHealth();
  }

  protected async getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init?.headers ?? {})
        }
      });

      if (response.status === 429) {
        this.reliability.recordRateLimit(response.headers.get("retry-after") ?? undefined);
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      this.reliability.recordFailure(error);
      return null;
    }
  }

  protected source(input: {
    id: string;
    provider: string;
    type: SourceRecord["type"];
    title: string;
    url?: string;
    publishedAt?: string;
    credibilityScore?: number;
  }): SourceRecord {
    return this.registry.registerSource({
      id: input.id,
      provider: input.provider,
      type: input.type,
      title: input.title,
      url: input.url,
      publishedAt: input.publishedAt,
      retrievedAt: nowIso(),
      credibilityScore: input.credibilityScore
    });
  }
}

export class FmpProvider
  extends HttpProviderBase
  implements MarketDataProvider, NewsProvider, EarningsProvider, MacroProvider, SectorProvider
{
  private readonly baseUrl = "https://financialmodelingprep.com/api/v3";
  private readonly stableUrl = "https://financialmodelingprep.com/stable";

  constructor(
    registry: LiveSourceRegistry,
    private readonly apiKey?: string,
    category: ProviderCategory = "market_data"
  ) {
    super(registry, {
      providerId: `fmp:${category}`,
      providerName: `Financial Modeling Prep (${category})`,
      category,
      apiKey,
      staleAfterMs: 60 * 60 * 1000
    });
  }

  async getEquityQuote(symbol: string): Promise<Quote | null> {
    return this.getQuote(normalizeSymbol(symbol), "equity");
  }

  async getForexQuote(pair: string): Promise<Quote | null> {
    const symbol = normalizeSymbol(pair);
    return this.getQuote(symbol, "forex");
  }

  async getCommodityQuote(asset: string): Promise<Quote | null> {
    const mapped = mapCommodityToFmp(normalizeSymbol(asset));
    return mapped ? this.getQuote(mapped, "commodity", normalizeSymbol(asset)) : null;
  }

  async getIndexMove(symbol: string): Promise<Quote | null> {
    const mapped = mapIndexToFmp(normalizeSymbol(symbol));
    return this.getQuote(mapped, "index", normalizeSymbol(symbol));
  }

  async getMovers(limit = 5): Promise<Quote[]> {
    if (!this.apiKey) {
      return [];
    }
    const url = `${this.baseUrl}/stock_market/gainers?apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    return rows.slice(0, limit).map((row) => this.quoteFromFmp(row, "equity")).filter(isQuote);
  }

  async getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]> {
    if (!this.apiKey || !input.symbol) {
      return [];
    }

    const symbol = normalizeSymbol(input.symbol);
    const limit = input.limit ?? 5;
    const url = `${this.baseUrl}/stock_news?tickers=${encodeURIComponent(symbol)}&limit=${limit}&apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    this.reliability.recordSuccess();
    return rows.slice(0, limit).map((row, index) => {
      const publishedAt = parseDate(row.publishedDate) ?? nowIso();
      const source = this.source({
        id: `fmp-news-${symbol}-${index}-${publishedAt}`,
        provider: "fmp",
        type: "news",
        title: stringValue(row.title) || "FMP company news",
        url: stringValue(row.url),
        publishedAt,
        credibilityScore: 80
      });
      return {
        id: source.id,
        sourceId: source.id,
        headline: source.title,
        summary: stringValue(row.text) || stringValue(row.site),
        url: source.url,
        sourceName: stringValue(row.site) || "Financial Modeling Prep",
        publishedAt,
        credibilityScore: 80
      };
    });
  }

  async getEarningsContext(symbolInput: string): Promise<EarningsContext | null> {
    if (!this.apiKey) {
      return null;
    }

    const symbol = normalizeSymbol(symbolInput);
    const { from, to } = dateWindow(45);
    const url = `${this.baseUrl}/earning_calendar?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    const row = rows[0];
    if (!row) {
      return null;
    }

    const publishedAt = parseDate(row.date) ?? nowIso();
    const source = this.source({
      id: `fmp-earnings-${symbol}-${publishedAt}`,
      provider: "fmp",
      type: "earnings",
      title: `${symbol} earnings calendar`,
      publishedAt,
      credibilityScore: 78
    });
    this.reliability.recordSuccess(publishedAt);
    return {
      nextReportAt: publishedAt,
      epsSurprisePercent: numberValue(row.epsEstimated) && numberValue(row.eps)
        ? percentDiff(numberValue(row.eps), numberValue(row.epsEstimated))
        : undefined,
      revenueSurprisePercent:
        numberValue(row.revenueEstimated) && numberValue(row.revenue)
          ? percentDiff(numberValue(row.revenue), numberValue(row.revenueEstimated))
          : undefined,
      guidance: "Earnings calendar data is available from live provider.",
      sourceId: source.id
    };
  }

  async getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]> {
    if (!this.apiKey) {
      return [];
    }

    const { from, to } = dateWindow(7);
    const url = `${this.baseUrl}/economic_calendar?from=${from}&to=${to}&apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    this.reliability.recordSuccess();
    return rows.slice(0, 10).map((row, index) => {
      const scheduledFor = parseDate(row.date) ?? nowIso();
      const source = this.source({
        id: `fmp-macro-${scope}-${index}-${scheduledFor}`,
        provider: "fmp",
        type: "macro",
        title: stringValue(row.event) || "Economic calendar event",
        publishedAt: scheduledFor,
        credibilityScore: 78
      });
      return {
        id: source.id,
        name: source.title,
        region: stringValue(row.country) || "global",
        importance: mapImportance(row.impact),
        scheduledFor,
        actual: stringValue(row.actual),
        consensus: stringValue(row.estimate),
        prior: stringValue(row.previous),
        sourceId: source.id
      };
    });
  }

  async getDxyContext(): Promise<MacroContext> {
    const quote = await this.getIndexMove("DXY");
    return macroContextFromQuote("DXY", quote);
  }

  async getYieldContext(): Promise<MacroContext> {
    const quote = await this.getIndexMove("US10Y");
    return quote
      ? macroContextFromQuote("U.S. 10Y yield", quote)
      : liveNoCatalystContext("U.S. yields", "Yield data unavailable from configured live provider.");
  }

  async getCentralBankContext(pair: string): Promise<MacroContext> {
    return liveNoCatalystContext(
      `${normalizeSymbol(pair)} central-bank context`,
      "Central-bank context requires configured macro calendar or rates provider data."
    );
  }

  async getInventoryContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} inventory context`, "Inventory data unavailable from configured live provider.");
  }

  async getSupplyDemandContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(
      `${normalizeSymbol(asset)} supply-demand context`,
      "Supply-demand context unavailable from configured live provider."
    );
  }

  async getGeopoliticalContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(
      `${normalizeSymbol(asset)} geopolitical context`,
      "Geopolitical context unavailable from configured live provider."
    );
  }

  async getSectorForSymbol(symbolInput: string): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }
    const symbol = normalizeSymbol(symbolInput);
    const url = `${this.baseUrl}/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    const sector = stringValue(rows[0]?.sector);
    if (sector) {
      this.reliability.recordSuccess();
    }
    return sector || null;
  }

  async getSectorPerformance(sector: string): Promise<number> {
    if (!this.apiKey) {
      return 0;
    }
    const url = `${this.stableUrl}/sector-performance?apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    const match = rows.find((row) => normalizeLoose(stringValue(row.sector)) === normalizeLoose(sector));
    const change = numberValue(match?.changesPercentage ?? match?.changePercentage);
    if (change !== undefined) {
      this.reliability.recordSuccess();
    }
    return change ?? 0;
  }

  private async getQuote(symbol: string, assetClass: Quote["assetClass"], displaySymbol = symbol): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }

    const url = `${this.baseUrl}/quote/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    const quote = this.quoteFromFmp(rows[0], assetClass, displaySymbol);
    if (quote) {
      this.reliability.recordSuccess(quote.asOf);
    }
    return quote;
  }

  private quoteFromFmp(row: Record<string, unknown> | undefined, assetClass: Quote["assetClass"], displaySymbol?: string): Quote | null {
    if (!row) {
      return null;
    }

    const symbol = displaySymbol ?? stringValue(row.symbol);
    const price = numberValue(row.price);
    const percentChange = numberValue(row.changesPercentage ?? row.changePercentage);
    if (!symbol || price === undefined || percentChange === undefined) {
      return null;
    }

    const timestamp = numberValue(row.timestamp);
    const asOf = timestamp ? new Date(timestamp * 1000).toISOString() : nowIso();
    const source = this.source({
      id: `fmp-quote-${normalizeSymbol(symbol)}`,
      provider: "fmp",
      type: "market_data",
      title: `${normalizeSymbol(symbol)} quote from Financial Modeling Prep`,
      publishedAt: asOf,
      credibilityScore: 80
    });
    return {
      symbol: normalizeSymbol(symbol),
      assetClass,
      price,
      percentChange,
      volume: numberValue(row.volume),
      relativeVolume: numberValue(row.avgVolume) && numberValue(row.volume)
        ? numberValue(row.volume)! / numberValue(row.avgVolume)!
        : undefined,
      asOf,
      sourceId: source.id,
      isStale: isOlderThan(asOf, 60 * 60 * 1000)
    };
  }
}

export class FinnhubProvider extends HttpProviderBase implements MarketDataProvider, NewsProvider, EarningsProvider, MacroProvider {
  private readonly baseUrl = "https://finnhub.io/api/v1";

  constructor(
    registry: LiveSourceRegistry,
    private readonly apiKey?: string,
    category: ProviderCategory = "news"
  ) {
    super(registry, {
      providerId: `finnhub:${category}`,
      providerName: `Finnhub (${category})`,
      category,
      apiKey,
      staleAfterMs: 60 * 60 * 1000
    });
  }

  async getEquityQuote(symbol: string): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }
    const normalized = normalizeSymbol(symbol);
    const url = `${this.baseUrl}/quote?symbol=${encodeURIComponent(normalized)}&token=${encodeURIComponent(this.apiKey)}`;
    const row = await this.getJson<Record<string, unknown>>(url);
    const price = numberValue(row?.c);
    const previousClose = numberValue(row?.pc);
    if (!price || !previousClose) {
      return null;
    }
    const asOf = nowIso();
    const source = this.source({
      id: `finnhub-quote-${normalized}`,
      provider: "finnhub",
      type: "market_data",
      title: `${normalized} quote from Finnhub`,
      publishedAt: asOf,
      credibilityScore: 78
    });
    const quote = {
      symbol: normalized,
      assetClass: "equity" as const,
      price,
      percentChange: percentDiff(price, previousClose) ?? 0,
      asOf,
      sourceId: source.id,
      isStale: false
    };
    this.reliability.recordSuccess(asOf);
    return quote;
  }

  async getForexQuote(pair: string): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }
    const normalized = normalizeSymbol(pair);
    const finnhubSymbol = `OANDA:${normalized.slice(0, 3)}_${normalized.slice(3)}`;
    const url = `${this.baseUrl}/quote?symbol=${encodeURIComponent(finnhubSymbol)}&token=${encodeURIComponent(this.apiKey)}`;
    const row = await this.getJson<Record<string, unknown>>(url);
    const price = numberValue(row?.c);
    const previousClose = numberValue(row?.pc);
    if (!price || !previousClose) {
      return null;
    }
    const asOf = nowIso();
    const source = this.source({
      id: `finnhub-quote-${normalized}`,
      provider: "finnhub",
      type: "market_data",
      title: `${normalized} FX quote from Finnhub`,
      publishedAt: asOf,
      credibilityScore: 76
    });
    this.reliability.recordSuccess(asOf);
    return {
      symbol: normalized,
      assetClass: "forex",
      price,
      percentChange: percentDiff(price, previousClose) ?? 0,
      asOf,
      sourceId: source.id,
      isStale: false
    };
  }

  async getCommodityQuote(_asset: string): Promise<Quote | null> {
    return null;
  }

  async getIndexMove(symbol: string): Promise<Quote | null> {
    return this.getEquityQuote(mapIndexToFinnhub(normalizeSymbol(symbol)));
  }

  async getMovers(): Promise<Quote[]> {
    return [];
  }

  async getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]> {
    if (!this.apiKey || !input.symbol) {
      return [];
    }
    const symbol = normalizeSymbol(input.symbol);
    const { from, to } = dateWindow(7);
    const url = `${this.baseUrl}/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${encodeURIComponent(this.apiKey)}`;
    const rows = (await this.getJson<Array<Record<string, unknown>>>(url)) ?? [];
    this.reliability.recordSuccess();
    return rows.slice(0, input.limit ?? 5).map((row, index) => {
      const publishedAt = numberValue(row.datetime)
        ? new Date(numberValue(row.datetime)! * 1000).toISOString()
        : nowIso();
      const source = this.source({
        id: `finnhub-news-${symbol}-${index}-${publishedAt}`,
        provider: "finnhub",
        type: "news",
        title: stringValue(row.headline) || "Finnhub company news",
        url: stringValue(row.url),
        publishedAt,
        credibilityScore: 82
      });
      return {
        id: source.id,
        sourceId: source.id,
        headline: source.title,
        summary: stringValue(row.summary),
        url: source.url,
        sourceName: stringValue(row.source) || "Finnhub",
        publishedAt,
        credibilityScore: 82
      };
    });
  }

  async getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]> {
    if (!this.apiKey) {
      return [];
    }
    const url = `${this.baseUrl}/calendar/economic?token=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ economicCalendar?: Array<Record<string, unknown>> }>(url);
    const rows = payload?.economicCalendar ?? [];
    this.reliability.recordSuccess();
    return rows.slice(0, 10).map((row, index) => {
      const scheduledFor = parseDate(row.time ?? row.date) ?? nowIso();
      const source = this.source({
        id: `finnhub-macro-${scope}-${index}-${scheduledFor}`,
        provider: "finnhub",
        type: "macro",
        title: stringValue(row.event) || "Economic calendar event",
        publishedAt: scheduledFor,
        credibilityScore: 78
      });
      return {
        id: source.id,
        name: source.title,
        region: stringValue(row.country) || "global",
        importance: mapImportance(row.impact),
        scheduledFor,
        actual: stringValue(row.actual),
        consensus: stringValue(row.estimate),
        prior: stringValue(row.prev),
        sourceId: source.id
      };
    });
  }

  async getDxyContext(): Promise<MacroContext> {
    return liveNoCatalystContext("DXY", "Dollar index context unavailable from configured live provider.");
  }

  async getYieldContext(): Promise<MacroContext> {
    return liveNoCatalystContext("U.S. yields", "Yield context unavailable from configured live provider.");
  }

  async getCentralBankContext(pair: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(pair)} central-bank context`, "Central-bank context depends on available macro calendar events.");
  }

  async getInventoryContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} inventory context`, "Inventory context unavailable from configured live provider.");
  }

  async getSupplyDemandContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} supply-demand context`, "Supply-demand context unavailable from configured live provider.");
  }

  async getGeopoliticalContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} geopolitical context`, "Geopolitical context unavailable from configured live provider.");
  }

  async getEarningsContext(symbolInput: string): Promise<EarningsContext | null> {
    if (!this.apiKey) {
      return null;
    }
    const symbol = normalizeSymbol(symbolInput);
    const { from, to } = dateWindow(45);
    const url = `${this.baseUrl}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ earningsCalendar?: Array<Record<string, unknown>> }>(url);
    const row = payload?.earningsCalendar?.[0];
    if (!row) {
      return null;
    }
    const publishedAt = parseDate(row.date) ?? nowIso();
    const source = this.source({
      id: `finnhub-earnings-${symbol}-${publishedAt}`,
      provider: "finnhub",
      type: "earnings",
      title: `${symbol} earnings calendar`,
      publishedAt,
      credibilityScore: 78
    });
    this.reliability.recordSuccess(publishedAt);
    return {
      nextReportAt: publishedAt,
      epsSurprisePercent:
        numberValue(row.epsEstimate) && numberValue(row.epsActual)
          ? percentDiff(numberValue(row.epsActual), numberValue(row.epsEstimate))
          : undefined,
      guidance: "Earnings calendar data is available from live provider.",
      sourceId: source.id
    };
  }
}

export class AlphaVantageProvider extends HttpProviderBase implements MarketDataProvider, NewsProvider, MacroProvider {
  private readonly baseUrl = "https://www.alphavantage.co/query";

  constructor(
    registry: LiveSourceRegistry,
    private readonly apiKey?: string,
    category: ProviderCategory = "market_data"
  ) {
    super(registry, {
      providerId: `alpha_vantage:${category}`,
      providerName: `Alpha Vantage (${category})`,
      category,
      apiKey,
      staleAfterMs: 24 * 60 * 60 * 1000
    });
  }

  async getEquityQuote(symbol: string): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }
    const normalized = normalizeSymbol(symbol);
    const url = `${this.baseUrl}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(normalized)}&apikey=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ "Global Quote"?: Record<string, unknown>; Note?: string }>(url);
    if (payload?.Note) {
      this.reliability.recordRateLimit();
      return null;
    }
    const row = payload?.["Global Quote"];
    const price = numberValue(row?.["05. price"]);
    const changePercent = parsePercent(row?.["10. change percent"]);
    const asOf = parseDate(row?.["07. latest trading day"]) ?? nowIso();
    if (price === undefined || changePercent === undefined) {
      return null;
    }
    const source = this.source({
      id: `alpha-quote-${normalized}`,
      provider: "alpha_vantage",
      type: "market_data",
      title: `${normalized} quote from Alpha Vantage`,
      publishedAt: asOf,
      credibilityScore: 78
    });
    const isStale = isOlderThan(asOf, 24 * 60 * 60 * 1000);
    this.reliability.recordSuccess(asOf);
    return {
      symbol: normalized,
      assetClass: "equity",
      price,
      percentChange: changePercent,
      volume: numberValue(row?.["06. volume"]),
      asOf,
      sourceId: source.id,
      isStale
    };
  }

  async getForexQuote(pair: string): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }
    const normalized = normalizeSymbol(pair);
    const from = normalized.slice(0, 3);
    const to = normalized.slice(3);
    const url = `${this.baseUrl}?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&apikey=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ "Time Series FX (Daily)"?: Record<string, Record<string, string>> }>(url);
    const series = payload?.["Time Series FX (Daily)"];
    const dates = Object.keys(series ?? {}).sort().reverse();
    const latestDate = dates[0];
    const previousDate = dates[1];
    if (!latestDate || !previousDate) {
      return null;
    }
    const latest = series?.[latestDate];
    const previous = series?.[previousDate];
    const price = numberValue(latest?.["4. close"]);
    const prevClose = numberValue(previous?.["4. close"]);
    if (price === undefined || prevClose === undefined) {
      return null;
    }
    const asOf = parseDate(latestDate) ?? nowIso();
    const source = this.source({
      id: `alpha-fx-${normalized}`,
      provider: "alpha_vantage",
      type: "market_data",
      title: `${normalized} FX quote from Alpha Vantage`,
      publishedAt: asOf,
      credibilityScore: 76
    });
    this.reliability.recordSuccess(asOf);
    return {
      symbol: normalized,
      assetClass: "forex",
      price,
      percentChange: percentDiff(price, prevClose) ?? 0,
      asOf,
      sourceId: source.id,
      isStale: isOlderThan(asOf, 48 * 60 * 60 * 1000)
    };
  }

  async getCommodityQuote(assetInput: string): Promise<Quote | null> {
    if (!this.apiKey) {
      return null;
    }
    const asset = normalizeSymbol(assetInput);
    const functionName = mapCommodityToAlpha(asset);
    if (!functionName) {
      return null;
    }
    const url = `${this.baseUrl}?function=${functionName}&interval=daily&apikey=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ data?: Array<Record<string, unknown>> }>(url);
    const latest = payload?.data?.find((row) => numberValue(row.value) !== undefined);
    const previous = payload?.data?.filter((row) => numberValue(row.value) !== undefined)[1];
    const price = numberValue(latest?.value);
    const prev = numberValue(previous?.value);
    if (price === undefined || prev === undefined) {
      return null;
    }
    const asOf = parseDate(latest?.date) ?? nowIso();
    const source = this.source({
      id: `alpha-commodity-${asset}`,
      provider: "alpha_vantage",
      type: "market_data",
      title: `${asset} commodity data from Alpha Vantage`,
      publishedAt: asOf,
      credibilityScore: 76
    });
    this.reliability.recordSuccess(asOf);
    return {
      symbol: asset,
      assetClass: "commodity",
      price,
      percentChange: percentDiff(price, prev) ?? 0,
      asOf,
      sourceId: source.id,
      isStale: isOlderThan(asOf, 48 * 60 * 60 * 1000)
    };
  }

  async getIndexMove(symbol: string): Promise<Quote | null> {
    return this.getEquityQuote(mapIndexToAlpha(normalizeSymbol(symbol)));
  }

  async getMovers(): Promise<Quote[]> {
    return [];
  }

  async getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]> {
    if (!this.apiKey || !input.symbol) {
      return [];
    }
    const symbol = normalizeSymbol(input.symbol);
    const url = `${this.baseUrl}?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&limit=${input.limit ?? 5}&apikey=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ feed?: Array<Record<string, unknown>>; Note?: string }>(url);
    if (payload?.Note) {
      this.reliability.recordRateLimit();
      return [];
    }
    this.reliability.recordSuccess();
    return (payload?.feed ?? []).slice(0, input.limit ?? 5).map((row, index) => {
      const publishedAt = parseAlphaNewsDate(row.time_published) ?? nowIso();
      const source = this.source({
        id: `alpha-news-${symbol}-${index}-${publishedAt}`,
        provider: "alpha_vantage",
        type: "news",
        title: stringValue(row.title) || "Alpha Vantage news",
        url: stringValue(row.url),
        publishedAt,
        credibilityScore: 78
      });
      return {
        id: source.id,
        sourceId: source.id,
        headline: source.title,
        summary: stringValue(row.summary),
        url: source.url,
        sourceName: stringValue(row.source) || "Alpha Vantage",
        publishedAt,
        credibilityScore: 78
      };
    });
  }

  async getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]> {
    const context = await this.getYieldContext();
    return [
      {
        id: `alpha-macro-${scope}-yield`,
        name: context.label,
        region: "US",
        importance: "medium",
        scheduledFor: context.asOf,
        actual: context.value,
        sourceId: context.sourceId ?? LIVE_WARNING_SOURCE.id
      }
    ];
  }

  async getDxyContext(): Promise<MacroContext> {
    const quote = await this.getIndexMove("DXY");
    return macroContextFromQuote("DXY", quote);
  }

  async getYieldContext(): Promise<MacroContext> {
    if (!this.apiKey) {
      return liveNoCatalystContext("U.S. yields", "Yield context unavailable from configured live provider.");
    }
    const url = `${this.baseUrl}?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${encodeURIComponent(this.apiKey)}`;
    const payload = await this.getJson<{ data?: Array<Record<string, unknown>> }>(url);
    const latest = payload?.data?.find((row) => numberValue(row.value) !== undefined);
    const asOf = parseDate(latest?.date) ?? nowIso();
    const source = this.source({
      id: "alpha-macro-us10y",
      provider: "alpha_vantage",
      type: "macro",
      title: "U.S. 10Y Treasury yield from Alpha Vantage",
      publishedAt: asOf,
      credibilityScore: 78
    });
    this.reliability.recordSuccess(asOf);
    return {
      label: "U.S. 10Y yield",
      value: `U.S. 10Y yield at ${stringValue(latest?.value) ?? "n/a"}%.`,
      bias: "mixed",
      sourceId: source.id,
      asOf
    };
  }

  async getCentralBankContext(pair: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(pair)} central-bank context`, "Central-bank context unavailable from configured live provider.");
  }

  async getInventoryContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} inventory context`, "Inventory context unavailable from configured live provider.");
  }

  async getSupplyDemandContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} supply-demand context`, "Supply-demand context unavailable from configured live provider.");
  }

  async getGeopoliticalContext(asset: string): Promise<MacroContext> {
    return liveNoCatalystContext(`${normalizeSymbol(asset)} geopolitical context`, "Geopolitical context unavailable from configured live provider.");
  }
}

export class SecFilingsProvider extends HttpProviderBase implements FilingsProvider {
  private readonly submissionsUrl = "https://data.sec.gov/submissions";
  private readonly tickerMapUrl = "https://www.sec.gov/files/company_tickers.json";
  private tickerMap?: Map<string, string>;

  constructor(
    registry: LiveSourceRegistry,
    private readonly userAgent?: string
  ) {
    super(registry, {
      providerId: "sec",
      providerName: "SEC EDGAR",
      category: "filings",
      apiKey: userAgent,
      staleAfterMs: 24 * 60 * 60 * 1000
    });
  }

  async getLatestFilings(symbolInput: string): Promise<FilingRecord[]> {
    if (!this.userAgent) {
      return [];
    }

    const symbol = normalizeSymbol(symbolInput);
    const cik = await this.lookupCik(symbol);
    if (!cik) {
      return [];
    }

    const url = `${this.submissionsUrl}/CIK${cik}.json`;
    const payload = await this.getJson<{ filings?: { recent?: Record<string, unknown[]> } }>(url, {
      headers: { "user-agent": this.userAgent }
    });
    const recent = payload?.filings?.recent;
    const forms = recent?.form ?? [];
    const dates = recent?.filingDate ?? [];
    const accessionNumbers = recent?.accessionNumber ?? [];
    const primaryDocuments = recent?.primaryDocument ?? [];
    const rows: FilingRecord[] = [];

    for (let index = 0; index < Math.min(forms.length, 5); index += 1) {
      const filingType = stringValue(forms[index]);
      const filedAt = parseDate(dates[index]) ?? nowIso();
      const accession = stringValue(accessionNumbers[index]);
      const document = stringValue(primaryDocuments[index]);
      const accessionPath = accession?.replace(/-/g, "");
      const filingUrl = accessionPath && document
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${document}`
        : undefined;
      const source = this.source({
        id: `sec-filing-${symbol}-${accession ?? index}`,
        provider: "sec",
        type: "official",
        title: `${symbol} ${filingType ?? "filing"}`,
        url: filingUrl,
        publishedAt: filedAt,
        credibilityScore: 96
      });
      rows.push({
        id: source.id,
        sourceId: source.id,
        symbol,
        filingType: filingType ?? "filing",
        title: source.title,
        filedAt,
        url: filingUrl
      });
    }

    this.reliability.recordSuccess(rows[0]?.filedAt);
    return rows;
  }

  private async lookupCik(symbol: string): Promise<string | null> {
    if (!this.tickerMap) {
      const payload = await this.getJson<Record<string, { ticker?: string; cik_str?: number }>>(this.tickerMapUrl, {
        headers: { "user-agent": this.userAgent ?? "market-desk-engine local" }
      });
      this.tickerMap = new Map(
        Object.values(payload ?? {}).map((row) => [
          normalizeSymbol(row.ticker ?? ""),
          String(row.cik_str ?? "").padStart(10, "0")
        ])
      );
    }

    return this.tickerMap.get(symbol) ?? null;
  }
}

export class FallbackMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly providers: MarketDataProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getEquityQuote(symbol: string): Promise<Quote | null> {
    return firstResult(this.providers, (provider) => provider.getEquityQuote(symbol), this.health);
  }

  getForexQuote(pair: string): Promise<Quote | null> {
    return firstResult(this.providers, (provider) => provider.getForexQuote(pair), this.health);
  }

  getCommodityQuote(asset: string): Promise<Quote | null> {
    return firstResult(this.providers, (provider) => provider.getCommodityQuote(asset), this.health);
  }

  getIndexMove(symbol: string): Promise<Quote | null> {
    return firstResult(this.providers, (provider) => provider.getIndexMove(symbol), this.health);
  }

  async getMovers(limit?: number): Promise<Quote[]> {
    return firstArray(this.providers, (provider) => provider.getMovers(limit), this.health);
  }
}

export class FallbackNewsProvider implements NewsProvider {
  constructor(
    private readonly providers: NewsProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]> {
    return firstArray(this.providers, (provider) => provider.getLatestNews(input), this.health);
  }
}

export class FallbackMacroProvider implements MacroProvider {
  constructor(
    private readonly providers: MacroProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]> {
    return firstArray(this.providers, (provider) => provider.getMacroEvents(scope), this.health);
  }

  getDxyContext(): Promise<MacroContext> {
    return firstContext(this.providers, (provider) => provider.getDxyContext(), this.health, "DXY");
  }

  getYieldContext(): Promise<MacroContext> {
    return firstContext(this.providers, (provider) => provider.getYieldContext(), this.health, "U.S. yields");
  }

  getCentralBankContext(pair: string): Promise<MacroContext> {
    return firstContext(
      this.providers,
      (provider) => provider.getCentralBankContext(pair),
      this.health,
      `${normalizeSymbol(pair)} central-bank context`
    );
  }

  getInventoryContext(asset: string): Promise<MacroContext> {
    return firstContext(
      this.providers,
      (provider) => provider.getInventoryContext(asset),
      this.health,
      `${normalizeSymbol(asset)} inventory context`
    );
  }

  getSupplyDemandContext(asset: string): Promise<MacroContext> {
    return firstContext(
      this.providers,
      (provider) => provider.getSupplyDemandContext(asset),
      this.health,
      `${normalizeSymbol(asset)} supply-demand context`
    );
  }

  getGeopoliticalContext(asset: string): Promise<MacroContext> {
    return firstContext(
      this.providers,
      (provider) => provider.getGeopoliticalContext(asset),
      this.health,
      `${normalizeSymbol(asset)} geopolitical context`
    );
  }
}

export class FallbackFilingsProvider implements FilingsProvider {
  constructor(
    private readonly providers: FilingsProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getLatestFilings(symbol: string): Promise<FilingRecord[]> {
    return firstArray(this.providers, (provider) => provider.getLatestFilings(symbol), this.health);
  }
}

export class FallbackEarningsProvider implements EarningsProvider {
  constructor(
    private readonly providers: EarningsProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getEarningsContext(symbol: string): Promise<EarningsContext | null> {
    return firstResult(this.providers, (provider) => provider.getEarningsContext(symbol), this.health);
  }
}

export class FallbackSectorProvider implements SectorProvider {
  constructor(
    private readonly providers: SectorProvider[],
    private readonly health: ProviderRouterHealth
  ) {}

  getSectorPerformance(sector: string): Promise<number> {
    return firstNumber(this.providers, (provider) => provider.getSectorPerformance(sector), this.health);
  }

  getSectorForSymbol(symbol: string): Promise<string | null> {
    return firstResult(this.providers, (provider) => provider.getSectorForSymbol(symbol), this.health);
  }
}

export class ProviderRouterHealth implements ProviderHealthReporter {
  private missingLiveDataWarnings = 0;

  noteMissingLiveData(): void {
    this.missingLiveDataWarnings += 1;
  }

  getProviderHealth(): ProviderHealthStatus[] {
    return [
      {
        providerId: "provider-router",
        providerName: "Provider priority router",
        category: "sources",
        configured: true,
        enabled: true,
        failedRequestCount: this.missingLiveDataWarnings,
        rateLimitStatus: "ok",
        staleDataWarning: this.missingLiveDataWarnings > 0,
        status: this.missingLiveDataWarnings > 0 ? "degraded" : "ok",
        message:
          this.missingLiveDataWarnings > 0
            ? "One or more live provider calls returned no usable data; mock fallback is allowed only in development/test."
            : "Provider priority routing is healthy."
      }
    ];
  }
}

export class CompositeHealthReporter implements ProviderHealthReporter {
  constructor(private readonly reporters: ProviderHealthReporter[]) {}

  getProviderHealth(): ProviderHealthStatus[] {
    return this.reporters.flatMap((reporter) => reporter.getProviderHealth());
  }
}

export class CompositeSourceProvider implements SourceProvider {
  constructor(private readonly providers: SourceProvider[]) {}

  async getSourcesByIds(ids: string[]): Promise<SourceRecord[]> {
    const results = await Promise.all(this.providers.map((provider) => provider.getSourcesByIds(ids)));
    const byId = new Map(results.flat().map((source) => [source.id, source]));
    return ids.map((id) => byId.get(id)).filter((source): source is SourceRecord => Boolean(source));
  }

  async getAllSources(): Promise<SourceRecord[]> {
    const results = await Promise.all(this.providers.map((provider) => provider.getAllSources()));
    return [...new Map(results.flat().map((source) => [source.id, source])).values()];
  }
}

export function createProviderBundleFromEnv(env: ProviderFactoryEnv, mockBundle?: ProviderBundle): ProviderBundle {
  const registry = new LiveSourceRegistry();
  const routerHealth = new ProviderRouterHealth();
  registry.registerHealthReporter(routerHealth);

  const allowMock = isMockFallbackAllowed(env);
  const mock = allowMock ? mockBundle : undefined;

  const marketDataProviders = buildProviders<MarketDataProvider>(env, "MARKET_DATA", registry, isMarketDataProvider);
  const newsProviders = buildProviders<NewsProvider>(env, "NEWS", registry, isNewsProvider);
  const macroProviders = buildProviders<MacroProvider>(env, "MACRO", registry, isMacroProvider);
  const filingsProviders = buildProviders<FilingsProvider>(env, "FILINGS", registry, isFilingsProvider);
  const earningsProviders = buildProviders<EarningsProvider>(env, "EARNINGS", registry, isEarningsProvider);
  const sectorProviders = buildProviders<SectorProvider>(env, "SECTOR", registry, isSectorProvider);

  return {
    marketData: new FallbackMarketDataProvider([...marketDataProviders, ...(mock ? [mock.marketData] : [])], routerHealth),
    news: new FallbackNewsProvider([...newsProviders, ...(mock ? [mock.news] : [])], routerHealth),
    macro: new FallbackMacroProvider([...macroProviders, ...(mock ? [mock.macro] : [])], routerHealth),
    filings: new FallbackFilingsProvider([...filingsProviders, ...(mock ? [mock.filings] : [])], routerHealth),
    earnings: new FallbackEarningsProvider([...earningsProviders, ...(mock ? [mock.earnings] : [])], routerHealth),
    sector: new FallbackSectorProvider([...sectorProviders, ...(mock ? [mock.sector] : [])], routerHealth),
    sources: new CompositeSourceProvider([registry, ...(mock ? [mock.sources] : [])]),
    health: new CompositeHealthReporter([registry, ...(mock?.health ? [mock.health] : [])])
  };
}

function buildProviders<T>(
  env: ProviderFactoryEnv,
  prefix: "MARKET_DATA" | "NEWS" | "MACRO" | "FILINGS" | "EARNINGS" | "SECTOR",
  registry: LiveSourceRegistry,
  predicate: (provider: unknown) => provider is T
): T[] {
  const providerNames = [
    env[`${prefix}_PRIMARY_PROVIDER` as keyof ProviderFactoryEnv],
    env[`${prefix}_BACKUP_PROVIDER` as keyof ProviderFactoryEnv]
  ]
    .map((name) => normalizeProviderName(String(name ?? "")))
    .filter(Boolean);

  return [...new Set(providerNames)]
    .map((providerName) => instantiateProvider(providerName, env, registry, categoryFromPrefix(prefix)))
    .filter(predicate);
}

function instantiateProvider(
  providerName: string,
  env: ProviderFactoryEnv,
  registry: LiveSourceRegistry,
  category: ProviderCategory
): unknown {
  if (providerName === "fmp") {
    return new FmpProvider(registry, env.FMP_API_KEY, category);
  }
  if (providerName === "finnhub") {
    return new FinnhubProvider(registry, env.FINNHUB_API_KEY, category);
  }
  if (providerName === "alpha_vantage") {
    return new AlphaVantageProvider(registry, env.ALPHA_VANTAGE_API_KEY, category);
  }
  if (providerName === "sec") {
    return new SecFilingsProvider(registry, env.SEC_USER_AGENT);
  }
  return undefined;
}

function categoryFromPrefix(
  prefix: "MARKET_DATA" | "NEWS" | "MACRO" | "FILINGS" | "EARNINGS" | "SECTOR"
): ProviderCategory {
  const map: Record<typeof prefix, ProviderCategory> = {
    MARKET_DATA: "market_data",
    NEWS: "news",
    MACRO: "macro",
    FILINGS: "filings",
    EARNINGS: "earnings",
    SECTOR: "sector"
  };
  return map[prefix];
}

function isMockFallbackAllowed(env: ProviderFactoryEnv): boolean {
  if (env.ALLOW_MOCK_PROVIDER_FALLBACK === "true") {
    return true;
  }
  if (env.ALLOW_MOCK_PROVIDER_FALLBACK === "false") {
    return false;
  }
  return env.NODE_ENV === "development" || env.NODE_ENV === "test" || !env.NODE_ENV;
}

async function firstResult<TProvider, TResult>(
  providers: TProvider[],
  call: (provider: TProvider) => Promise<TResult | null>,
  health: ProviderRouterHealth
): Promise<TResult | null> {
  for (const provider of providers) {
    const result = await call(provider);
    if (result) {
      return result;
    }
  }
  health.noteMissingLiveData();
  return null;
}

async function firstArray<TProvider, TResult>(
  providers: TProvider[],
  call: (provider: TProvider) => Promise<TResult[]>,
  health: ProviderRouterHealth
): Promise<TResult[]> {
  for (const provider of providers) {
    const result = await call(provider);
    if (result.length > 0) {
      return result;
    }
  }
  health.noteMissingLiveData();
  return [];
}

async function firstNumber<TProvider>(
  providers: TProvider[],
  call: (provider: TProvider) => Promise<number>,
  health: ProviderRouterHealth
): Promise<number> {
  for (const provider of providers) {
    const result = await call(provider);
    if (result !== 0) {
      return result;
    }
  }
  health.noteMissingLiveData();
  return 0;
}

async function firstContext<TProvider>(
  providers: TProvider[],
  call: (provider: TProvider) => Promise<MacroContext>,
  health: ProviderRouterHealth,
  label: string
): Promise<MacroContext> {
  for (const provider of providers) {
    const result = await call(provider);
    if (result.sourceId !== LIVE_WARNING_SOURCE.id) {
      return result;
    }
  }
  health.noteMissingLiveData();
  return liveNoCatalystContext(label, "There is no clean confirmed catalyst from available live sources at the time of writing.");
}

function isMarketDataProvider(provider: unknown): provider is MarketDataProvider {
  return Boolean(provider && typeof (provider as MarketDataProvider).getEquityQuote === "function");
}

function isNewsProvider(provider: unknown): provider is NewsProvider {
  return Boolean(provider && typeof (provider as NewsProvider).getLatestNews === "function");
}

function isMacroProvider(provider: unknown): provider is MacroProvider {
  return Boolean(provider && typeof (provider as MacroProvider).getMacroEvents === "function");
}

function isFilingsProvider(provider: unknown): provider is FilingsProvider {
  return Boolean(provider && typeof (provider as FilingsProvider).getLatestFilings === "function");
}

function isEarningsProvider(provider: unknown): provider is EarningsProvider {
  return Boolean(provider && typeof (provider as EarningsProvider).getEarningsContext === "function");
}

function isSectorProvider(provider: unknown): provider is SectorProvider {
  return Boolean(provider && typeof (provider as SectorProvider).getSectorForSymbol === "function");
}

function isQuote(input: Quote | null): input is Quote {
  return Boolean(input);
}

function liveNoCatalystContext(label: string, value: string): MacroContext {
  return {
    label,
    value,
    bias: "mixed",
    sourceId: LIVE_WARNING_SOURCE.id,
    asOf: nowIso()
  };
}

function macroContextFromQuote(label: string, quote: Quote | null): MacroContext {
  if (!quote) {
    return liveNoCatalystContext(label, `${label} data unavailable from configured live provider.`);
  }
  return {
    label,
    value: `${label} is ${quote.percentChange >= 0 ? "up" : "down"} ${Math.abs(quote.percentChange).toFixed(2)}%.`,
    bias: quote.percentChange >= 0 ? "pressuring" : "supportive",
    sourceId: quote.sourceId,
    asOf: quote.asOf
  };
}

function normalizeProviderName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

function normalizeLoose(value?: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapCommodityToFmp(asset: string): string | null {
  const map: Record<string, string> = {
    GOLD: "GCUSD",
    OIL: "CLUSD",
    WTI: "CLUSD",
    NATGAS: "NGUSD"
  };
  return map[asset] ?? asset;
}

function mapCommodityToAlpha(asset: string): string | null {
  const map: Record<string, string> = {
    OIL: "WTI",
    WTI: "WTI",
    NATGAS: "NATURAL_GAS"
  };
  return map[asset] ?? null;
}

function mapIndexToFmp(symbol: string): string {
  const map: Record<string, string> = {
    SPY: "SPY",
    QQQ: "QQQ",
    DXY: "DX-Y.NYB",
    US10Y: "^TNX"
  };
  return map[symbol] ?? symbol;
}

function mapIndexToAlpha(symbol: string): string {
  const map: Record<string, string> = {
    SPY: "SPY",
    QQQ: "QQQ",
    DXY: "UUP",
    US10Y: "IEF"
  };
  return map[symbol] ?? symbol;
}

function mapIndexToFinnhub(symbol: string): string {
  const map: Record<string, string> = {
    SPY: "SPY",
    QQQ: "QQQ",
    DXY: "UUP",
    US10Y: "IEF"
  };
  return map[symbol] ?? symbol;
}

function dateWindow(daysForward: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - 7);
  const to = new Date(now);
  to.setDate(now.getDate() + daysForward);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
}

function parseDate(input: unknown): string | undefined {
  const value = stringValue(input);
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAlphaNewsDate(input: unknown): string | undefined {
  const value = stringValue(input);
  if (!value || value.length < 8) {
    return undefined;
  }
  const date = new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11) || "00"}:${value.slice(11, 13) || "00"}:00Z`
  );
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,$]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parsePercent(value: unknown): number | undefined {
  return numberValue(value);
}

function percentDiff(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) {
    return undefined;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

function mapImportance(value: unknown): MacroEvent["importance"] {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("high") || normalized === "3") {
    return "high";
  }
  if (normalized.includes("low") || normalized === "1") {
    return "low";
  }
  return "medium";
}

function isOlderThan(isoDate: string, maxAgeMs: number): boolean {
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) {
    return true;
  }
  return Date.now() - time > maxAgeMs;
}
