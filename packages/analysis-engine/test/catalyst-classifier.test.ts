import { describe, expect, it } from "vitest";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle } from "@market-desk/data-providers";
import { CatalystClassifier } from "../src";

describe("CatalystClassifier", () => {
  const snapshots = new MarketSnapshotService(createMockProviderBundle());
  const classifier = new CatalystClassifier();

  it("prioritizes official filings as confirmed company-specific catalysts", async () => {
    const snapshot = await snapshots.getEquitySnapshot("AAPL");
    const catalysts = classifier.classify(snapshot);

    expect(catalysts[0]?.classification).toBe("company_specific");
    expect(catalysts[0]?.confidenceScore).toBeGreaterThanOrEqual(90);
    expect(catalysts[0]?.sourceIds).toContain("src-filing-aapl");
  });

  it("classifies FX moves around rate expectations and macro context", async () => {
    const snapshot = await snapshots.getForexSnapshot("EURUSD");
    const catalysts = classifier.classify(snapshot);

    expect(catalysts.map((item) => item.classification)).toContain("fx_rate_expectation");
  });

  it("classifies oil around inventory and supply-demand context", async () => {
    const snapshot = await snapshots.getCommoditySnapshot("OIL");
    const catalysts = classifier.classify(snapshot);

    expect(catalysts[0]?.classification).toBe("commodity_supply_demand");
    expect(catalysts[0]?.sourceIds).toContain("src-commodity-eia");
  });

  it("uses the required no-confirmed-catalyst language when live sources are stale or missing", async () => {
    const snapshot = await snapshots.getForexSnapshot("EURUSD");
    const catalysts = classifier.classify({
      ...snapshot,
      sources: [
        ...snapshot.sources,
        {
          id: "src-live-source-warning",
          provider: "provider-router",
          type: "internal",
          title: "There is no clean confirmed catalyst from available live sources at the time of writing.",
          retrievedAt: new Date().toISOString(),
          credibilityScore: 100
        }
      ]
    });

    expect(catalysts[0]?.classification).toBe("no_confirmed_catalyst");
    expect(catalysts[0]?.explanation).toBe(
      "There is no clean confirmed catalyst from available live sources at the time of writing."
    );
  });
});
