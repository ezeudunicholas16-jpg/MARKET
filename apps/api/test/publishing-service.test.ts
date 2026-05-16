import { AnalysisPipeline, AnalysisResult } from "@market-desk/analysis-engine";
import { TelegramClient } from "@market-desk/telegram";
import { describe, expect, it } from "vitest";
import { PublishingDraftRecord, PublishingDraftStore, PublishingService } from "../src/publishing";

describe("PublishingService", () => {
  it("does not publish a blocked draft even when approve is requested", async () => {
    const store = new PublishingDraftStore();
    const service = new PublishingService({
      pipeline: {} as AnalysisPipeline,
      telegram: new TelegramClient(),
      store,
      publishingMode: "auto_post"
    });
    const record: PublishingDraftRecord = {
      id: "blocked-draft",
      symbol: "TSLA",
      assetClass: "equity",
      mode: "equity_mover_reaction",
      result: {
        draft: {
          title: "TSLA update",
          body: "There is no confirmed catalyst.\n\nMarket commentary only."
        }
      } as AnalysisResult,
      decision: {
        mode: "auto_post",
        status: "blocked",
        confidenceScore: 30,
        cautiousLanguageRequired: false,
        reasons: ["Confidence is below 45 and the draft is not in no_confirmed_catalyst format."],
        warnings: []
      },
      status: "blocked",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.upsert(record);

    const result = await service.handleAction(record.id, "approve");

    expect(result.message).toContain("cannot be approved");
    expect(result.record.status).toBe("blocked");
    expect(result.record.publishedAt).toBeUndefined();
  });
});
