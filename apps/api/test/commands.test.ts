import { afterEach, describe, expect, it } from "vitest";
import { createServices } from "../src/app";
import { handleTelegramCommand } from "../src/commands";

const originalEnv = { ...process.env };

describe("Telegram command behavior", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("/status includes live provider configuration and AI status", async () => {
    process.env.LIVE_DATA_ENABLED = "true";
    process.env.MARKET_DATA_PROVIDER = "twelve_data";
    process.env.FOREX_PROVIDER = "twelve_data";
    process.env.COMMODITY_PROVIDER = "twelve_data";
    process.env.INDEX_PROVIDER = "twelve_data";
    const services = createServices();

    const result = await handleTelegramCommand(
      { command: "/status", args: [], rawArgs: "" },
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: services.providers.health
      }
    );

    expect(result.text).toContain("Live data enabled: true");
    expect(result.text).toContain("Market provider: Twelve Data");
    expect(result.text).toContain("AI provider: Gemini");
  });

  it("/market does not return legacy mock brief text", async () => {
    const services = createServices();
    const result = await handleTelegramCommand(
      { command: "/market", args: [], rawArgs: "" },
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: services.providers.health
      }
    );

    expect(result.text).not.toContain("Global mock brief");
  });

  it("/status exposes last AI provider and fallback reason", async () => {
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "";
    const services = createServices();

    await handleTelegramCommand(
      { command: "/why", args: ["NVDA"], rawArgs: "NVDA" },
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: services.providers.health
      }
    );
    const result = await handleTelegramCommand(
      { command: "/status", args: [], rawArgs: "" },
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: services.providers.health
      }
    );

    expect(result.text).toContain("Last AI provider used: gemini");
    expect(result.text).toContain("Last AI fallback reason: missing Gemini API key");
    expect(result.text).toContain("Gemini configured: false");
  });

  it("/status groups provider errors and sanitizes provider messages", async () => {
    const services = createServices();
    const result = await handleTelegramCommand(
      { command: "/status", args: [], rawArgs: "" },
      {
        pipeline: services.pipeline,
        marketData: services.providers.marketData,
        compliance: services.compliance,
        telegram: services.telegram,
        publishing: services.publishing,
        providerHealth: {
          getProviderHealth: () => [
            {
              providerId: "twelve_data:market_data",
              providerName: "Twelve Data",
              category: "market_data",
              configured: true,
              enabled: true,
              failedRequestCount: 2,
              rateLimitStatus: "ok",
              staleDataWarning: false,
              status: "degraded",
              lastFailedRequestAt: "2026-05-16T12:00:00.000Z",
              lastErrorName: "ProviderResponseError",
              endpointCategory: "market_data",
              message: "HTTP 500 from https://api.twelvedata.com/quote?symbol=NVDA&apikey=secret-key."
            }
          ]
        }
      }
    );

    expect(result.text).toContain("Last provider error name: ProviderResponseError");
    expect(result.text).toContain("Last provider endpoint/category: market_data");
    expect(result.text).toContain("Provider error counts: twelve_data:market_data=2");
    expect(result.text).not.toContain("secret-key");
  });
});
