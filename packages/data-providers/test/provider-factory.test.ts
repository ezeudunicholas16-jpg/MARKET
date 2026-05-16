import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveSourceRegistry,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  TwelveDataProvider,
  createMockProviderBundle,
  createProviderBundleFromEnv,
  mapSymbolForTwelveData
} from "../src";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("createProviderBundleFromEnv", () => {
  it("uses mock fallback in test when live providers are not configured", async () => {
    const bundle = createProviderBundleFromEnv({ NODE_ENV: "test" }, createMockProviderBundle());
    const quote = await bundle.marketData.getEquityQuote("NVDA");

    expect(quote?.symbol).toBe("NVDA");
    expect(bundle.health?.getProviderHealth().some((item) => item.providerId === "mock")).toBe(true);
  });

  it("does not use mock fallback in production unless explicitly enabled", async () => {
    const bundle = createProviderBundleFromEnv({ NODE_ENV: "production" }, createMockProviderBundle());
    const quote = await bundle.marketData.getEquityQuote("NVDA");
    const health = bundle.health?.getProviderHealth() ?? [];

    expect(quote).toBeNull();
    expect(health.some((item) => item.providerId === "mock")).toBe(false);
    expect(health.some((item) => item.providerId === "provider-router" && item.staleDataWarning)).toBe(true);
  });

  it("exposes configured live providers through health without hardcoded secrets", () => {
    const bundle = createProviderBundleFromEnv(
      {
        NODE_ENV: "production",
        MARKET_DATA_PRIMARY_PROVIDER: "fmp",
        MARKET_DATA_BACKUP_PROVIDER: "alpha_vantage",
        FMP_API_KEY: "test-fmp-key",
        ALPHA_VANTAGE_API_KEY: "test-alpha-key"
      },
      createMockProviderBundle()
    );
    const health = bundle.health?.getProviderHealth() ?? [];

    expect(health.map((item) => item.providerId)).toEqual(
      expect.arrayContaining(["fmp:market_data", "alpha_vantage:market_data"])
    );
    expect(JSON.stringify(health)).not.toContain("test-fmp-key");
    expect(JSON.stringify(health)).not.toContain("test-alpha-key");
  });

  it("uses Twelve Data in production when LIVE_DATA_ENABLED is true and does not add mock fallback", async () => {
    const bundle = createProviderBundleFromEnv(
      {
        NODE_ENV: "production",
        LIVE_DATA_ENABLED: "true",
        MARKET_DATA_PROVIDER: "twelve_data",
        TWELVE_DATA_API_KEY: "test-twelve-key"
      },
      createMockProviderBundle()
    );

    expect(bundle.health?.getProviderHealth().some((item) => item.providerId === "mock")).toBe(false);
    expect(bundle.health?.getProviderHealth().some((item) => item.providerId === "twelve_data:market_data")).toBe(true);
  });

  it("returns ProviderConfigError when Twelve Data is selected without an API key", async () => {
    const bundle = createProviderBundleFromEnv(
      {
        NODE_ENV: "production",
        LIVE_DATA_ENABLED: "true",
        MARKET_DATA_PROVIDER: "twelve_data"
      },
      createMockProviderBundle()
    );

    await expect(bundle.marketData.getEquityQuote("NVDA")).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("tracks missing optional source data as a warning, not a provider error", async () => {
    const bundle = createProviderBundleFromEnv({ NODE_ENV: "production", NEWS_PROVIDER: "finnhub" }, createMockProviderBundle());

    const news = await bundle.news.getLatestNews({ symbol: "NVDA", assetClass: "equity" });
    const routerHealth = bundle.health?.getProviderHealth().find((item) => item.providerId === "provider-router");

    expect(news).toEqual([]);
    expect(routerHealth?.failedRequestCount).toBe(0);
    expect(routerHealth?.lastErrorName).toBeUndefined();
    expect(routerHealth?.optionalSourceWarningCount).toBeGreaterThan(0);
    expect(routerHealth?.lastOptionalSourceWarning).toBeTruthy();
  });

  it("maps key Twelve Data symbols", () => {
    expect(mapSymbolForTwelveData("NVDA", "equity").candidates[0]).toBe("NVDA");
    expect(mapSymbolForTwelveData("EURUSD", "forex").candidates[0]).toBe("EUR/USD");
    expect(mapSymbolForTwelveData("GOLD", "commodity").candidates[0]).toBe("XAU/USD");
  });

  it("normalizes Twelve Data equity quote responses", async () => {
    mockTwelveDataFetch({
      price: { price: "100" },
      quote: {
        symbol: "NVDA",
        name: "NVIDIA Corporation",
        exchange: "NASDAQ",
        currency: "USD",
        datetime: "2026-05-15",
        open: "98",
        high: "101",
        low: "97",
        close: "100",
        previous_close: "95",
        volume: "1200"
      }
    });
    const provider = new TwelveDataProvider(new LiveSourceRegistry(), "secret-key");
    const quote = await provider.getEquityQuote("NVDA");

    expect(quote).toMatchObject({
      symbol: "NVDA",
      assetClass: "equity",
      price: 100,
      previousClose: 95,
      percentChange: expect.closeTo(5.263, 3),
      sourceName: "twelve_data",
      providerSymbol: "NVDA"
    });
  });

  it("normalizes Twelve Data forex and commodity symbols", async () => {
    mockTwelveDataFetch({
      price: { price: "1.1" },
      quote: {
        symbol: "EUR/USD",
        datetime: "2026-05-15",
        close: "1.1",
        previous_close: "1.0",
        percent_change: "10"
      }
    });
    const forex = await new TwelveDataProvider(new LiveSourceRegistry(), "secret-key").getForexQuote("EURUSD");
    expect(forex?.providerSymbol).toBe("EUR/USD");

    mockTwelveDataFetch({
      price: { price: "2400" },
      quote: {
        symbol: "XAU/USD",
        datetime: "2026-05-15",
        close: "2400",
        previous_close: "2300",
        percent_change: "4.3478"
      }
    });
    const commodity = await new TwelveDataProvider(new LiveSourceRegistry(), "secret-key").getCommodityQuote("GOLD");
    expect(commodity?.providerSymbol).toBe("XAU/USD");
  });

  it("sanitizes API keys from Twelve Data provider errors", async () => {
    global.fetch = vi.fn(async () => new Response("fail", { status: 500 })) as typeof fetch;
    const provider = new TwelveDataProvider(new LiveSourceRegistry(), "super-secret-key");

    await expect(provider.getEquityQuote("NVDA")).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(provider.getEquityQuote("NVDA")).rejects.not.toThrow("super-secret-key");
  });

  it("starts cooldown when Twelve Data returns rate limit", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ status: "error", code: 429, message: "rate limit reached" })
    ) as typeof fetch;
    const provider = new TwelveDataProvider(new LiveSourceRegistry(), "secret-key");

    await expect(provider.getForexQuote("EURUSD")).rejects.toBeInstanceOf(ProviderRateLimitError);
    const health = provider.getProviderHealth()[0];

    expect(health?.cooldownActive).toBe(true);
    expect(health?.rateLimitStatus).toBe("limited");
    expect(health?.message).not.toContain("secret-key");
  });

  it("uses cached quote during cooldown instead of hammering Twelve Data", async () => {
    process.env.TWELVE_DATA_MAX_REQUESTS_PER_MINUTE = "1";
    process.env.TWELVE_DATA_MIN_REQUEST_INTERVAL_MS = "0";
    const fetchMock = vi.fn(async () =>
      Response.json({
        symbol: "NVDA",
        datetime: "2026-05-15",
        close: "100",
        previous_close: "95",
        percent_change: "5.26"
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const provider = new TwelveDataProvider(new LiveSourceRegistry(), "secret-key");

    const live = await provider.getEquityQuote("NVDA");
    const cached = await provider.getEquityQuote("NVDA");
    const stale = await provider.debugAsset("NVDA", true);

    expect(live?.providerStatus?.quoteSource).toBe("live");
    expect(cached?.providerStatus?.quoteSource).toBe("cache");
    expect(stale.quoteSource).toBe("stale-cache");
    expect((stale.sanitizedData as Record<string, unknown> | null)?.isStale).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getProviderHealth()[0]?.cooldownActive).toBe(true);
  });
});

function mockTwelveDataFetch(input: { price: Record<string, unknown>; quote: Record<string, unknown> }): void {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("/price")) {
      return Response.json(input.price);
    }
    if (value.includes("/quote")) {
      return Response.json(input.quote);
    }
    if (value.includes("/time_series")) {
      return Response.json({ values: [] });
    }
    return Response.json({ data: [] });
  }) as typeof fetch;
}
