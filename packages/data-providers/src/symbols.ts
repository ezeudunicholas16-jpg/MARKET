import { AssetClass, normalizeSymbol } from "@market-desk/shared";

export type ProviderAssetType = AssetClass;

export interface SymbolMapping {
  requested: string;
  assetType: ProviderAssetType;
  normalized: string;
  candidates: string[];
}

const stockSymbols = new Set(["NVDA", "AAPL", "TSLA", "MSFT", "META", "AMZN", "GOOGL", "NFLX", "AMD"]);

const forexMap: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDCAD: "USDCAD".replace("USDCAD", "USD/CAD"),
  AUDUSD: "AUD/USD",
  NZDUSD: "NZD/USD",
  USDCHF: "USD/CHF"
};

const commodityMap: Record<string, string[]> = {
  GOLD: ["XAU/USD"],
  XAUUSD: ["XAU/USD"],
  SILVER: ["XAG/USD"],
  XAGUSD: ["XAG/USD"],
  OIL: ["WTI/USD", "WTI", "CL"],
  WTI: ["WTI/USD", "WTI", "CL"],
  BRENT: ["BRENT/USD", "BRENT", "BZ"],
  NATGAS: ["NATURAL GAS", "NATGAS", "NG"]
};

const indexMap: Record<string, string[]> = {
  SPX: ["SPX", "SPY", "S&P 500"],
  NDX: ["NDX", "QQQ", "NASDAQ 100"],
  DJI: ["DJI", "DIA", "DOW JONES"],
  DXY: ["DXY", "USDX", "UUP", "US DOLLAR INDEX"]
};

export function mapSymbolForTwelveData(input: string, preferredType?: ProviderAssetType): SymbolMapping {
  const normalized = normalizeSymbol(input);
  const assetType = preferredType ?? detectAssetType(normalized);

  if (assetType === "forex") {
    return {
      requested: input,
      assetType,
      normalized,
      candidates: [forexMap[normalized] ?? slashForex(normalized)]
    };
  }

  if (assetType === "commodity") {
    return {
      requested: input,
      assetType,
      normalized,
      candidates: commodityMap[normalized] ?? [normalized]
    };
  }

  if (assetType === "index") {
    return {
      requested: input,
      assetType,
      normalized,
      candidates: indexMap[normalized] ?? [normalized]
    };
  }

  return {
    requested: input,
    assetType,
    normalized,
    candidates: [normalized]
  };
}

export function detectAssetType(input: string): ProviderAssetType {
  const normalized = normalizeSymbol(input);
  if (forexMap[normalized] || /^[A-Z]{6}$/.test(normalized)) {
    return "forex";
  }
  if (commodityMap[normalized]) {
    return "commodity";
  }
  if (indexMap[normalized]) {
    return "index";
  }
  if (stockSymbols.has(normalized)) {
    return "equity";
  }
  return "equity";
}

export function displaySymbolForAsset(symbol: string, assetType: ProviderAssetType): string {
  if (assetType === "forex") {
    return normalizeSymbol(symbol);
  }
  return normalizeSymbol(symbol);
}

function slashForex(symbol: string): string {
  return symbol.length === 6 ? `${symbol.slice(0, 3)}/${symbol.slice(3)}` : symbol;
}
