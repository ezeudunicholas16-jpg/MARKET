import { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("live provider routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("/debug/provider returns sanitized Twelve Data provider info", async () => {
    process.env.NODE_ENV = "production";
    process.env.LIVE_DATA_ENABLED = "true";
    process.env.MARKET_DATA_PROVIDER = "twelve_data";
    process.env.NEWS_PROVIDER = "";
    process.env.MACRO_PROVIDER = "";
    process.env.FILINGS_PROVIDER = "";
    process.env.TWELVE_DATA_API_KEY = "test-twelve-key";
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.API_AUTH_REQUIRED = "false";
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/price")) {
        return Response.json({ price: "100" });
      }
      if (value.includes("/quote")) {
        return Response.json({
          symbol: "NVDA",
          datetime: "2026-05-15",
          close: "100",
          previous_close: "95",
          percent_change: "5.26"
        });
      }
      return Response.json({ data: [] });
    }) as typeof fetch;
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/debug/provider/NVDA?refresh=true" });

    expect(response.statusCode).toBe(200);
    const text = response.body;
    const payload = response.json() as {
      selectedProvider: string;
      normalizedSymbol: string;
      quoteFound: boolean;
      newsChecked: boolean;
      newsCount: number;
      macroChecked: boolean;
      macroCount: number;
      catalystLabel: string;
      catalystConfidence: number;
      geminiEligible: boolean;
      geminiWouldBeCalled: boolean;
      sanitizedData: { sourceName: string };
    };
    expect(payload.selectedProvider).toBe("twelve_data");
    expect(payload.normalizedSymbol).toBe("NVDA");
    expect(payload.quoteFound).toBe(true);
    expect(payload.newsChecked).toBe(true);
    expect(payload.newsCount).toBe(0);
    expect(payload.macroChecked).toBe(false);
    expect(payload.macroCount).toBe(0);
    expect(payload.catalystLabel).toContain("NVDA");
    expect(payload.catalystConfidence).toBeGreaterThan(0);
    expect(payload.geminiEligible).toBe(true);
    expect(payload.geminiWouldBeCalled).toBe(true);
    expect(payload.sanitizedData.sourceName).toBe("twelve_data");
    expect(text).not.toContain("test-twelve-key");
    expect(text).not.toContain("test-gemini-key");
  });
});
