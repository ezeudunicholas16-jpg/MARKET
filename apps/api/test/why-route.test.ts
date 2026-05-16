import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

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
});
