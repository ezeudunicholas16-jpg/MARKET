import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FastifyInstance } from "fastify";
import { AnalysisPipeline, AiUsageTracker, GeminiAnalystWriter, GeminiGenerateClient } from "@market-desk/analysis-engine";
import { ComplianceEngine } from "@market-desk/compliance";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle, ProviderBundle } from "@market-desk/data-providers";
import { nowIso, SourceRecord } from "@market-desk/shared";
import { TelegramClient } from "@market-desk/telegram";
import { buildApp } from "../src/app";
import { PublishingDraftStore, PublishingService } from "../src/publishing";

describe("GET /why/:symbol", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns an equity explanation using mock providers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/why/NVDA?mode=public_telegram"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      snapshot: { symbol: string; detectedCatalysts: unknown[] };
      draft: { body: string; confidence: { score: number } };
      compliance: { status: string };
    };

    expect(payload.snapshot.symbol).toBe("NVDA");
    expect(payload.snapshot.detectedCatalysts.length).toBeGreaterThan(0);
    expect(payload.draft.body).toContain("Market commentary only.");
    expect(payload.draft.confidence.score).toBeGreaterThanOrEqual(70);
    expect(["approved", "rewritten", "review_required"]).toContain(payload.compliance.status);
  });

  it("returns provider health checks", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/providers"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      providers: Array<{ providerId: string; failedRequestCount: number; staleDataWarning: boolean }>;
    };
    expect(payload.providers.length).toBeGreaterThan(0);
    expect(payload.providers.some((provider) => provider.providerId === "mock")).toBe(true);
  });

  it("/why NVDA with quote data and no confirmed catalyst uses Gemini text successfully", async () => {
    const tracker = new AiUsageTracker();
    const providers = noConfirmedCatalystProviders();
    const compliance = new ComplianceEngine();
    const telegram = new TelegramClient(undefined, undefined);
    const pipeline = new AnalysisPipeline(
      new MarketSnapshotService(providers),
      undefined,
      undefined,
      new GeminiAnalystWriter({
        client: rawTextGeminiClient([
          "NVDA is firmer today, but there is no clean confirmed catalyst from available live sources at the time of writing.\n\nThe stock read is mainly about price action against semiconductor and index context, with no company headline, filing, or earnings update confirming the move.\n\nThe next useful evidence would be credible company news, an official filing, or clearer sector follow-through.\n\nMarket commentary only."
        ]),
        tracker
      }),
      compliance
    );
    const draftStore = new PublishingDraftStore();
    const testApp = await buildApp({
      services: {
        snapshots: new MarketSnapshotService(providers),
        pipeline,
        compliance,
        telegram,
        providers,
        publishing: new PublishingService({
          pipeline,
          telegram,
          store: draftStore,
          publishingMode: "approval_required"
        }),
        draftStore
      }
    });

    try {
      const response = await testApp.inject({ method: "GET", url: "/why/NVDA?mode=public_telegram" });
      const payload = response.json() as {
        draft: { body: string; catalyst: { classification: string } };
      };

      expect(response.statusCode).toBe(200);
      expect(payload.draft.catalyst.classification).toBe("no_confirmed_catalyst");
      expect(payload.draft.body).toContain("NVDA is firmer today");
      expect(payload.draft.body).toMatch(/Market commentary only\.$/);
      expect(payload.draft.body.split(/\n\s*\n/).length).toBeGreaterThanOrEqual(3);
      expect(payload.draft.body.split(/\s+/).length).toBeGreaterThanOrEqual(45);
      expect(payload.draft.body).toMatch(/stock read|sector|index/i);
      expect(payload.draft.body).toMatch(/next useful evidence|follow-through|what matters next/i);
      expect(tracker.today("gemini").filter((record) => record.success).length).toBe(1);
      expect(tracker.today("gemini").filter((record) => record.fallbackUsed).length).toBe(0);
    } finally {
      await testApp.close();
    }
  });

  it("missing macro provider does not block commodity Gemini commentary", async () => {
    const tracker = new AiUsageTracker();
    const providers = commodityWithoutMacroProviders();
    const compliance = new ComplianceEngine();
    const telegram = new TelegramClient(undefined, undefined);
    const pipeline = new AnalysisPipeline(
      new MarketSnapshotService(providers),
      undefined,
      undefined,
      new GeminiAnalystWriter({
        client: rawTextGeminiClient([
          "Gold is little changed rather than directionally weak, with live quote data showing only a small move.\n\nWith no confirmed macro or safe-haven catalyst from the current source set, the cleaner read is consolidation while the market waits for clearer dollar, yield, or inflation evidence.\n\nWhat matters next is DXY, Treasury yields, Fed expectations, incoming inflation data, and whether safe-haven demand starts to show up more clearly.\n\nMarket commentary only."
        ]),
        tracker
      }),
      compliance
    );
    const draftStore = new PublishingDraftStore();
    const testApp = await buildApp({
      services: {
        snapshots: new MarketSnapshotService(providers),
        pipeline,
        compliance,
        telegram,
        providers,
        publishing: new PublishingService({
          pipeline,
          telegram,
          store: draftStore,
          publishingMode: "approval_required"
        }),
        draftStore
      }
    });

    try {
      const response = await testApp.inject({ method: "GET", url: "/commodity/GOLD?mode=commodity_reaction" });
      const payload = response.json() as {
        draft: { body: string; catalyst: { classification: string } };
      };

      expect(response.statusCode).toBe(200);
      expect(payload.draft.catalyst.classification).toBe("no_confirmed_catalyst");
      expect(payload.draft.body).toMatch(/Gold|GOLD/);
      expect(payload.draft.body).toContain("little changed");
      expect(payload.draft.body).toMatch(/DXY|Treasury yields|Fed expectations|inflation/i);
      expect(payload.draft.body).toMatch(/Market commentary only\.$/);
      expect(tracker.today("gemini").filter((record) => record.success).length).toBe(1);
      expect(tracker.today("gemini").filter((record) => record.fallbackUsed).length).toBe(0);
    } finally {
      await testApp.close();
    }
  });
});

function rawTextGeminiClient(responses: string[]): GeminiGenerateClient {
  return {
    models: {
      async generateContent() {
        return { text: responses.shift() ?? "" };
      }
    }
  };
}

function noConfirmedCatalystProviders(): ProviderBundle {
  const base = createMockProviderBundle();
  const source: SourceRecord = {
    id: "src-twelve-nvda",
    provider: "twelve_data",
    type: "market_data",
    title: "Twelve Data NVDA quote",
    retrievedAt: nowIso(),
    credibilityScore: 85
  };

  return {
    ...base,
    marketData: {
      ...base.marketData,
      async getEquityQuote() {
        return {
          symbol: "NVDA",
          assetClass: "equity" as const,
          price: 100,
          percentChange: 1.2,
          volume: 1000000,
          relativeVolume: 1.05,
          sourceId: source.id,
          sourceName: "twelve_data",
          asOf: nowIso()
        };
      },
      async getIndexMove() {
        return {
          symbol: "QQQ",
          assetClass: "index" as const,
          price: 500,
          percentChange: 0,
          sourceId: "src-index-qqq",
          sourceName: "twelve_data",
          asOf: nowIso()
        };
      }
    },
    sector: {
      async getSectorForSymbol() {
        return "Semiconductors";
      },
      async getSectorPerformance() {
        return 0;
      }
    },
    news: {
      async getLatestNews() {
        return [];
      }
    },
    filings: {
      async getLatestFilings() {
        return [];
      }
    },
    earnings: {
      async getEarningsContext() {
        return null;
      }
    },
    sources: {
      async getSourcesByIds(ids) {
        return ids.map((id) => ({
          ...source,
          id,
          title: id === source.id ? source.title : "Twelve Data index quote"
        }));
      },
      async getAllSources() {
        return [source];
      }
    }
  };
}

function commodityWithoutMacroProviders(): ProviderBundle {
  const base = createMockProviderBundle();
  const source: SourceRecord = {
    id: "src-twelve-gold",
    provider: "twelve_data",
    type: "market_data",
    title: "Twelve Data GOLD quote",
    retrievedAt: nowIso(),
    credibilityScore: 85
  };

  return {
    ...base,
    marketData: {
      ...base.marketData,
      async getCommodityQuote() {
        return {
          symbol: "GOLD",
          assetClass: "commodity" as const,
          price: 2400,
          percentChange: 0.05,
          sourceId: source.id,
          sourceName: "twelve_data",
          asOf: nowIso()
        };
      }
    },
    macro: {
      async getMacroEvents() {
        throw new Error("FRED unavailable");
      },
      async getDxyContext() {
        throw new Error("FRED unavailable");
      },
      async getYieldContext() {
        throw new Error("FRED unavailable");
      },
      async getCentralBankContext() {
        throw new Error("FRED unavailable");
      },
      async getInventoryContext() {
        throw new Error("Inventory unavailable");
      },
      async getSupplyDemandContext() {
        throw new Error("Supply-demand unavailable");
      },
      async getGeopoliticalContext() {
        throw new Error("Geopolitical unavailable");
      }
    },
    sources: {
      async getSourcesByIds(ids) {
        return ids.map((id) => ({ ...source, id }));
      },
      async getAllSources() {
        return [source];
      }
    }
  };
}
