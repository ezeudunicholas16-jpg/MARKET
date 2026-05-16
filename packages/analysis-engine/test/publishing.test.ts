import { describe, expect, it } from "vitest";
import { ComplianceResult } from "@market-desk/compliance";
import { AnalysisDraft, CatalystCandidate, MarketSnapshot } from "@market-desk/shared";
import { evaluatePublishingDecision } from "../src";

const catalyst: CatalystCandidate = {
  classification: "company_specific",
  label: "Official filing",
  evidence: [{ sourceId: "src", kind: "filing", summary: "8-K filing confirms the update.", weight: 0.9 }],
  confidenceScore: 90,
  sourceIds: ["src"],
  explanation: "Official filing confirms the update."
};

const snapshot: MarketSnapshot = {
  assetClass: "equity",
  symbol: "AAPL",
  price: 200,
  percentChange: 1.2,
  volume: 1000,
  relativeVolume: 1.1,
  sector: "Technology",
  sectorMove: 0.5,
  indexMove: 0.4,
  latestNews: [],
  latestFilings: [],
  earningsContext: null,
  detectedCatalysts: [catalyst],
  generatedAt: new Date().toISOString(),
  sources: [{ id: "src", provider: "test", type: "official", title: "Official source" }]
};

const compliance: ComplianceResult = {
  status: "approved",
  flags: [],
  originalText: "AAPL is firmer. The move appears linked to the filing.\n\nMarket commentary only.",
  finalText: "AAPL is firmer. The move appears linked to the filing.\n\nMarket commentary only."
};

function draft(score: number, body = compliance.finalText, classification = catalyst.classification): AnalysisDraft {
  return {
    mode: "public_telegram",
    title: "AAPL update",
    body,
    confidence: { score, band: score >= 85 ? "confirmed" : "strong", rationale: "test", requiresReview: false },
    catalyst: { ...catalyst, classification },
    sourcesUsed: ["src"]
  };
}

describe("evaluatePublishingDecision", () => {
  it("allows auto-post for high confidence and clear compliance", () => {
    const decision = evaluatePublishingDecision({ mode: "auto_post", draft: draft(90), compliance, snapshot });

    expect(decision.status).toBe("auto_post_allowed");
  });

  it("requires cautious language for medium confidence", () => {
    const decision = evaluatePublishingDecision({
      mode: "auto_post",
      draft: draft(75, "AAPL is firmer on filing evidence.\n\nMarket commentary only."),
      compliance,
      snapshot
    });

    expect(decision.status).toBe("approval_required");
    expect(decision.reasons.join(" ")).toContain("cautious language");
  });

  it("requires approval for 45-64 confidence", () => {
    const decision = evaluatePublishingDecision({ mode: "auto_post", draft: draft(55), compliance, snapshot });

    expect(decision.status).toBe("approval_required");
  });

  it("blocks sub-45 confidence unless no_confirmed_catalyst format is used", () => {
    const blocked = evaluatePublishingDecision({ mode: "auto_post", draft: draft(35), compliance, snapshot });
    const allowedForReview = evaluatePublishingDecision({
      mode: "auto_post",
      draft: draft(35, compliance.finalText, "no_confirmed_catalyst"),
      compliance,
      snapshot
    });

    expect(blocked.status).toBe("blocked");
    expect(allowedForReview.status).toBe("auto_post_allowed");
  });

  it("requires approval when source warnings are present outside no-confirmed-catalyst framing", () => {
    const decision = evaluatePublishingDecision({
      mode: "auto_post",
      draft: draft(90),
      compliance,
      snapshot: {
        ...snapshot,
        sources: [
          ...snapshot.sources,
          { id: "src-live-source-warning", provider: "router", type: "internal", title: "stale" }
        ]
      }
    });

    expect(decision.status).toBe("approval_required");
  });
});
