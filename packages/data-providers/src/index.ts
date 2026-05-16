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
import type { ProviderHealthReporter, ProviderHealthStatus } from "./live";

export interface MarketDataProvider {
  getEquityQuote(symbol: string): Promise<Quote | null>;
  getForexQuote(pair: string): Promise<Quote | null>;
  getCommodityQuote(asset: string): Promise<Quote | null>;
  getIndexMove(symbol: string): Promise<Quote | null>;
  getMovers(limit?: number): Promise<Quote[]>;
}

export interface SectorProvider {
  getSectorPerformance(sector: string): Promise<number>;
  getSectorForSymbol(symbol: string): Promise<string | null>;
}

export interface NewsProvider {
  getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]>;
}

export interface MacroProvider {
  getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]>;
  getDxyContext(): Promise<MacroContext>;
  getYieldContext(): Promise<MacroContext>;
  getCentralBankContext(pair: string): Promise<MacroContext>;
  getInventoryContext(asset: string): Promise<MacroContext>;
  getSupplyDemandContext(asset: string): Promise<MacroContext>;
  getGeopoliticalContext(asset: string): Promise<MacroContext>;
}

export interface FilingsProvider {
  getLatestFilings(symbol: string): Promise<FilingRecord[]>;
}

export interface EarningsProvider {
  getEarningsContext(symbol: string): Promise<EarningsContext | null>;
}

export interface SourceProvider {
  getSourcesByIds(ids: string[]): Promise<SourceRecord[]>;
  getAllSources(): Promise<SourceRecord[]>;
}

export interface ProviderBundle {
  marketData: MarketDataProvider;
  sector: SectorProvider;
  news: NewsProvider;
  macro: MacroProvider;
  filings: FilingsProvider;
  earnings: EarningsProvider;
  sources: SourceProvider;
  health?: ProviderHealthReporter;
}

const sourceCatalog: SourceRecord[] = [
  {
    id: "src-market-mock",
    provider: "mock-market-data",
    type: "market_data",
    title: "Mock consolidated market data tape",
    retrievedAt: nowIso(),
    credibilityScore: 80
  },
  {
    id: "src-news-nvda",
    provider: "mock-newswire",
    type: "news",
    title: "Hyperscaler capex commentary supports AI chip demand",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 82
  },
  {
    id: "src-news-tsla",
    provider: "mock-newswire",
    type: "news",
    title: "Tesla pressured after delivery mix update",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 78
  },
  {
    id: "src-filing-aapl",
    provider: "mock-sec",
    type: "official",
    title: "Apple files 8-K on capital return authorization",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 95
  },
  {
    id: "src-earnings-nvda",
    provider: "mock-company-ir",
    type: "earnings",
    title: "NVIDIA earnings release and guidance summary",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 96
  },
  {
    id: "src-macro-us",
    provider: "mock-macro-calendar",
    type: "macro",
    title: "U.S. macro calendar and rates snapshot",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 84
  },
  {
    id: "src-commodity-eia",
    provider: "mock-energy-inventory",
    type: "official",
    title: "Mock weekly energy inventory update",
    publishedAt: nowIso(),
    retrievedAt: nowIso(),
    credibilityScore: 91
  }
];

const equityQuotes: Record<string, Quote> = {
  AAPL: {
    symbol: "AAPL",
    assetClass: "equity",
    price: 203.44,
    percentChange: 1.18,
    volume: 52400000,
    relativeVolume: 1.12,
    asOf: nowIso()
  },
  NVDA: {
    symbol: "NVDA",
    assetClass: "equity",
    price: 132.87,
    percentChange: 3.84,
    volume: 61200000,
    relativeVolume: 1.78,
    asOf: nowIso()
  },
  TSLA: {
    symbol: "TSLA",
    assetClass: "equity",
    price: 178.21,
    percentChange: -2.16,
    volume: 43800000,
    relativeVolume: 1.34,
    asOf: nowIso()
  }
};

const forexQuotes: Record<string, Quote> = {
  EURUSD: { symbol: "EURUSD", assetClass: "forex", price: 1.0842, percentChange: -0.34, asOf: nowIso() },
  GBPUSD: { symbol: "GBPUSD", assetClass: "forex", price: 1.2725, percentChange: 0.18, asOf: nowIso() },
  DXY: { symbol: "DXY", assetClass: "index", price: 104.32, percentChange: 0.41, asOf: nowIso() }
};

const commodityQuotes: Record<string, Quote> = {
  GOLD: { symbol: "GOLD", assetClass: "commodity", price: 2384.3, percentChange: 1.05, asOf: nowIso() },
  OIL: { symbol: "OIL", assetClass: "commodity", price: 77.42, percentChange: -1.31, asOf: nowIso() },
  NATGAS: { symbol: "NATGAS", assetClass: "commodity", price: 2.81, percentChange: 2.44, asOf: nowIso() }
};

const indexQuotes: Record<string, Quote> = {
  SPY: { symbol: "SPY", assetClass: "index", price: 541.28, percentChange: 0.62, asOf: nowIso() },
  QQQ: { symbol: "QQQ", assetClass: "index", price: 462.95, percentChange: 0.96, asOf: nowIso() },
  DXY: forexQuotes.DXY
};

const symbolSector: Record<string, string> = {
  AAPL: "Technology",
  NVDA: "Semiconductors",
  TSLA: "Automobiles"
};

const sectorMoves: Record<string, number> = {
  Technology: 0.78,
  Semiconductors: 2.15,
  Automobiles: -0.72
};

const newsBySymbol: Record<string, NewsItem[]> = {
  NVDA: [
    {
      id: "news-nvda-1",
      sourceId: "src-news-nvda",
      headline: "NVIDIA extends gains as hyperscaler AI capex commentary supports chip demand",
      summary: "Mock newswire notes stronger AI infrastructure spending commentary across large cloud customers.",
      sourceName: "Mock Newswire",
      publishedAt: nowIso(),
      credibilityScore: 82
    }
  ],
  TSLA: [
    {
      id: "news-tsla-1",
      sourceId: "src-news-tsla",
      headline: "Tesla trades lower after delivery mix update and margin questions",
      summary: "Mock newswire cites investor focus on delivery mix and pricing pressure.",
      sourceName: "Mock Newswire",
      publishedAt: nowIso(),
      credibilityScore: 78
    }
  ],
  AAPL: [
    {
      id: "news-aapl-1",
      sourceId: "src-filing-aapl",
      headline: "Apple announces additional capital return authorization in 8-K filing",
      summary: "Mock official filing reference for capital return authorization.",
      sourceName: "Mock SEC",
      publishedAt: nowIso(),
      credibilityScore: 95
    }
  ],
  GOLD: [
    {
      id: "news-gold-1",
      sourceId: "src-macro-us",
      headline: "Gold firms as real-yield tone eases ahead of U.S. inflation data",
      summary: "Mock macro note links precious metals demand to rates and dollar context.",
      sourceName: "Mock Macro Desk",
      publishedAt: nowIso(),
      credibilityScore: 81
    }
  ],
  OIL: [
    {
      id: "news-oil-1",
      sourceId: "src-commodity-eia",
      headline: "Oil slips after inventory build offsets geopolitical risk premium",
      summary: "Mock inventory update shows a larger-than-expected crude stock build.",
      sourceName: "Mock Energy Inventory",
      publishedAt: nowIso(),
      credibilityScore: 91
    }
  ]
};

const filingsBySymbol: Record<string, FilingRecord[]> = {
  AAPL: [
    {
      id: "filing-aapl-8k",
      sourceId: "src-filing-aapl",
      symbol: "AAPL",
      filingType: "8-K",
      title: "Capital return authorization update",
      filedAt: nowIso()
    }
  ]
};

const earningsBySymbol: Record<string, EarningsContext> = {
  NVDA: {
    lastReportedAt: nowIso(),
    epsSurprisePercent: 8.4,
    revenueSurprisePercent: 5.7,
    guidance: "Management commentary points to continued data-center demand strength.",
    sourceId: "src-earnings-nvda"
  }
};

function source(id: string): SourceRecord | undefined {
  return sourceCatalog.find((item) => item.id === id);
}

export class MockProviderBundle
  implements
    MarketDataProvider,
    SectorProvider,
    NewsProvider,
    MacroProvider,
    FilingsProvider,
    EarningsProvider,
    SourceProvider
{
  get bundle(): ProviderBundle {
    return {
      marketData: this,
      sector: this,
      news: this,
      macro: this,
      filings: this,
      earnings: this,
      sources: this,
      health: this
    };
  }

  getProviderHealth(): ProviderHealthStatus[] {
    return [
      {
        providerId: "mock",
        providerName: "Mock provider bundle",
        category: "mock" as const,
        configured: true,
        enabled: true,
        lastSuccessfulRequestAt: nowIso(),
        failedRequestCount: 0,
        rateLimitStatus: "ok" as const,
        staleDataWarning: false,
        status: "ok" as const,
        message: "Development/test mock provider."
      }
    ];
  }

  async getEquityQuote(symbol: string): Promise<Quote | null> {
    return equityQuotes[normalizeSymbol(symbol)] ?? null;
  }

  async getForexQuote(pair: string): Promise<Quote | null> {
    return forexQuotes[normalizeSymbol(pair)] ?? null;
  }

  async getCommodityQuote(asset: string): Promise<Quote | null> {
    return commodityQuotes[normalizeSymbol(asset)] ?? null;
  }

  async getIndexMove(symbolName: string): Promise<Quote | null> {
    return indexQuotes[normalizeSymbol(symbolName)] ?? null;
  }

  async getMovers(limit = 5): Promise<Quote[]> {
    return [...Object.values(equityQuotes), ...Object.values(forexQuotes), ...Object.values(commodityQuotes)]
      .sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange))
      .slice(0, limit);
  }

  async getSectorPerformance(sector: string): Promise<number> {
    return sectorMoves[sector] ?? 0;
  }

  async getSectorForSymbol(symbol: string): Promise<string | null> {
    return symbolSector[normalizeSymbol(symbol)] ?? null;
  }

  async getLatestNews(input: { symbol?: string; assetClass?: AssetClass; limit?: number }): Promise<NewsItem[]> {
    const limit = input.limit ?? 5;
    if (input.symbol) {
      return (newsBySymbol[normalizeSymbol(input.symbol)] ?? []).slice(0, limit);
    }

    return Object.values(newsBySymbol).flat().slice(0, limit);
  }

  async getLatestFilings(symbol: string): Promise<FilingRecord[]> {
    return filingsBySymbol[normalizeSymbol(symbol)] ?? [];
  }

  async getEarningsContext(symbol: string): Promise<EarningsContext | null> {
    return earningsBySymbol[normalizeSymbol(symbol)] ?? null;
  }

  async getMacroEvents(scope: "global" | "equity" | "forex" | "commodity"): Promise<MacroEvent[]> {
    const events: MacroEvent[] = [
      {
        id: `macro-${scope}-cpi`,
        name: "U.S. CPI",
        region: "US",
        importance: "high",
        scheduledFor: nowIso(),
        consensus: "0.3% m/m",
        prior: "0.2% m/m",
        sourceId: "src-macro-us"
      },
      {
        id: `macro-${scope}-fedspeak`,
        name: "Fed speakers",
        region: "US",
        importance: "medium",
        scheduledFor: nowIso(),
        sourceId: "src-macro-us"
      }
    ];
    return events;
  }

  async getDxyContext(): Promise<MacroContext> {
    return {
      label: "DXY",
      value: "Dollar index up 0.41% on the mock tape",
      bias: "pressuring",
      sourceId: "src-macro-us",
      asOf: nowIso()
    };
  }

  async getYieldContext(): Promise<MacroContext> {
    return {
      label: "U.S. yields",
      value: "Front-end yields slightly firmer as rate-cut expectations are repriced",
      bias: "pressuring",
      sourceId: "src-macro-us",
      asOf: nowIso()
    };
  }

  async getCentralBankContext(pair: string): Promise<MacroContext> {
    return {
      label: `${normalizeSymbol(pair)} central-bank context`,
      value: "Rate-path differentials remain the main macro input in the mock FX feed",
      bias: normalizeSymbol(pair) === "GBPUSD" ? "mixed" : "pressuring",
      sourceId: "src-macro-us",
      asOf: nowIso()
    };
  }

  async getInventoryContext(asset: string): Promise<MacroContext> {
    const normalized = normalizeSymbol(asset);
    return {
      label: `${normalized} inventory context`,
      value:
        normalized === "OIL"
          ? "Mock inventory data show a larger crude stock build"
          : "No major inventory shock in the mock feed",
      bias: normalized === "OIL" ? "pressuring" : "neutral",
      sourceId: normalized === "OIL" ? "src-commodity-eia" : "src-market-mock",
      asOf: nowIso()
    };
  }

  async getSupplyDemandContext(asset: string): Promise<MacroContext> {
    const normalized = normalizeSymbol(asset);
    return {
      label: `${normalized} supply-demand context`,
      value:
        normalized === "NATGAS"
          ? "Warmer weather assumptions support near-term demand in the mock model"
          : "Supply-demand balance is mixed on the mock provider feed",
      bias: normalized === "NATGAS" ? "supportive" : "mixed",
      sourceId: normalized === "OIL" ? "src-commodity-eia" : "src-market-mock",
      asOf: nowIso()
    };
  }

  async getGeopoliticalContext(asset: string): Promise<MacroContext> {
    return {
      label: `${normalizeSymbol(asset)} geopolitical context`,
      value: "Geopolitical risk premium is present but not the dominant confirmed input",
      bias: "mixed",
      sourceId: "src-market-mock",
      asOf: nowIso()
    };
  }

  async getSourcesByIds(ids: string[]): Promise<SourceRecord[]> {
    return ids.map(source).filter((item): item is SourceRecord => Boolean(item));
  }

  async getAllSources(): Promise<SourceRecord[]> {
    return sourceCatalog;
  }
}

export function createMockProviderBundle(): ProviderBundle {
  return new MockProviderBundle().bundle;
}

export * from "./live";
export * from "./symbols";
