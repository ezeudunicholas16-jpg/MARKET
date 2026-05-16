import { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("publishing routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates an approval-gated draft by default", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/publishing/drafts",
      payload: { symbol: "NVDA", assetClass: "equity" }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      id: string;
      symbol: string;
      status: string;
      decision: { status: string; reasons: string[] };
      result: { draft: { body: string } };
    };

    expect(payload.symbol).toBe("NVDA");
    expect(payload.status).toBe("draft");
    expect(payload.decision.status).toBe("approval_required");
    expect(payload.decision.reasons.join(" ")).toContain("manual approval");
    expect(payload.result.draft.body).toContain("Market commentary only.");
  });

  it("approves a draft and records it as published", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/publishing/drafts",
      payload: { symbol: "GOLD", assetClass: "commodity" }
    });
    const draft = created.json() as { id: string };

    const approved = await app.inject({
      method: "POST",
      url: `/publishing/drafts/${draft.id}/actions`,
      payload: { action: "approve" }
    });

    expect(approved.statusCode).toBe(200);
    const payload = approved.json() as {
      record: { status: string; publishedAt?: string };
      message: string;
    };
    expect(payload.record.status).toBe("approved");
    expect(payload.record.publishedAt).toBeDefined();
    expect(payload.message).toContain("Approved");
  });
});
