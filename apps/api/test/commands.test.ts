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
});
