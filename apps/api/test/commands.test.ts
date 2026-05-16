import { afterEach, describe, expect, it } from "vitest";
import { AnalysisPipeline, AiUsageTracker, GeminiAnalystWriter, GeminiGenerateClient } from "@market-desk/analysis-engine";
import { ComplianceEngine } from "@market-desk/compliance";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle } from "@market-desk/data-providers";
import { TelegramClient } from "@market-desk/telegram";
import { createServices } from "../src/app";
import { handleTelegramCommand } from "../src/commands";
import { PublishingDraftStore, PublishingService } from "../src/publishing";

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
    expect(result.text).toContain("Last AI provider attempted: none");
    expect(result.text).toContain("Last AI fallback reason: missing Gemini API key");
    expect(result.text).toContain("Gemini configured: false");
  });

  it("/status exposes sanitized last Gemini error", async () => {
    const providers = createMockProviderBundle();
    const compliance = new ComplianceEngine();
    const telegram = new TelegramClient(undefined, undefined);
    const pipeline = new AnalysisPipeline(
      new MarketSnapshotService(providers),
      undefined,
      undefined,
      new GeminiAnalystWriter({
        client: failingGeminiClient("Gemini failed with key=test-secret"),
        tracker: new AiUsageTracker()
      }),
      compliance
    );
    const draftStore = new PublishingDraftStore();
    const publishing = new PublishingService({
      pipeline,
      telegram,
      store: draftStore,
      publishingMode: "approval_required"
    });

    await handleTelegramCommand(
      { command: "/why", args: ["NVDA"], rawArgs: "NVDA" },
      {
        pipeline,
        marketData: providers.marketData,
        compliance,
        telegram,
        publishing,
        providerHealth: providers.health
      }
    );
    const result = await handleTelegramCommand(
      { command: "/status", args: [], rawArgs: "" },
      {
        pipeline,
        marketData: providers.marketData,
        compliance,
        telegram,
        publishing,
        providerHealth: providers.health
      }
    );

    expect(result.text).toContain("Last AI call attempted: true");
    expect(result.text).toContain("Last Gemini success: false");
    expect(result.text).toContain("Last Gemini raw response usable: false");
    expect(result.text).toContain("Last Gemini JSON parse recovered: false");
    expect(result.text).toContain("Last Gemini response mode: text");
    expect(result.text).toContain("Last original Gemini quality passed: false");
    expect(result.text).toContain("Last quality check passed:");
    expect(result.text).toContain("Last rewrite attempted: false");
    expect(result.text).toContain("Last rewrite quality passed: false");
    expect(result.text).toContain("Last final writer used: template");
    expect(result.text).toContain("Last Gemini original output word count: none");
    expect(result.text).toContain("Last Gemini rewrite output word count: none");
    expect(result.text).toContain("Last final output word count:");
    expect(result.text).toContain("Last quality failure reasons:");
    expect(result.text).toContain("Last quality text evaluated source: final");
    expect(result.text).toContain("Last Gemini error: Gemini failed with key=[redacted]");
    expect(result.text).toContain("Last AI fallback reason: Gemini failed with key=[redacted]");
    expect(result.text).not.toContain("test-secret");
  });

  it("/status reports Gemini as the final writer when original output passes quality", async () => {
    const providers = createMockProviderBundle();
    const compliance = new ComplianceEngine();
    const telegram = new TelegramClient(undefined, undefined);
    const pipeline = new AnalysisPipeline(
      new MarketSnapshotService(providers),
      undefined,
      undefined,
      new GeminiAnalystWriter({
        client: successfulGeminiClient(),
        tracker: new AiUsageTracker()
      }),
      compliance
    );
    const draftStore = new PublishingDraftStore();
    const publishing = new PublishingService({
      pipeline,
      telegram,
      store: draftStore,
      publishingMode: "approval_required"
    });

    await handleTelegramCommand(
      { command: "/why", args: ["NVDA"], rawArgs: "NVDA" },
      {
        pipeline,
        marketData: providers.marketData,
        compliance,
        telegram,
        publishing,
        providerHealth: providers.health
      }
    );
    const result = await handleTelegramCommand(
      { command: "/status", args: [], rawArgs: "" },
      {
        pipeline,
        marketData: providers.marketData,
        compliance,
        telegram,
        publishing,
        providerHealth: providers.health
      }
    );

    expect(result.text).toContain("Last Gemini success: true");
    expect(result.text).toContain("Last original Gemini quality passed: true");
    expect(result.text).toContain("Last rewrite attempted: false");
    expect(result.text).toContain("Last final writer used: gemini");
    expect(result.text).toContain("Last quality text evaluated source: original");
    expect(result.text).toContain("Last AI fallback reason: none");
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
    expect(result.text).toContain("Required quote provider errors: 2");
    expect(result.text).toContain("Required provider error counts: twelve_data:market_data=2");
    expect(result.text).not.toContain("secret-key");
  });
});

function failingGeminiClient(message: string): GeminiGenerateClient {
  return {
    models: {
      async generateContent() {
        throw new Error(message);
      }
    }
  };
}

function successfulGeminiClient(): GeminiGenerateClient {
  return {
    models: {
      async generateContent() {
        return {
          text: [
            "NVDA is firmer today, with live pricing showing a clear move in the stock and volume giving the reaction more weight than a simple quote update.",
            "The cleaner read is that semiconductor participation, index context, and company-specific evidence need to be considered together before treating the move as an isolated NVDA story.",
            "The next check is whether fresh company commentary, sector breadth, Nasdaq direction, or official filings confirm the move.",
            "Market commentary only."
          ].join("\n\n")
        };
      }
    }
  };
}
