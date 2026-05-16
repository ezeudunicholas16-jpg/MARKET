import { describe, expect, it } from "vitest";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle } from "@market-desk/data-providers";
import { CatalystCandidate } from "@market-desk/shared";
import { CatalystClassifier, ConfidenceEngine } from "../src";

describe("ConfidenceEngine", () => {
  const snapshots = new MarketSnapshotService(createMockProviderBundle());
  const classifier = new CatalystClassifier();
  const confidence = new ConfidenceEngine();

  it("scores official-source catalysts in the confirmed band", async () => {
    const snapshot = await snapshots.getEquitySnapshot("AAPL");
    const catalysts = classifier.classify(snapshot);
    const result = confidence.score(snapshot, catalysts);

    expect(result.band).toBe("confirmed");
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.requiresReview).toBe(false);
  });

  it("forces no-confirmed-catalyst cases into review", async () => {
    const snapshot = await snapshots.getForexSnapshot("GBPUSD");
    const weakCatalyst: CatalystCandidate = {
      classification: "no_confirmed_catalyst",
      label: "No confirmed catalyst",
      evidence: [],
      confidenceScore: 35,
      sourceIds: [],
      explanation: "No source evidence confirms the move."
    };
    const result = confidence.score(snapshot, [weakCatalyst]);

    expect(result.band).toBe("weak");
    expect(result.score).toBeLessThan(50);
    expect(result.requiresReview).toBe(true);
  });
});
