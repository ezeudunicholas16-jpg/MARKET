import { describe, expect, it } from "vitest";
import { createMockProviderBundle, createProviderBundleFromEnv } from "../src";

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
});
