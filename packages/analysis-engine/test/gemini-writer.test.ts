import { describe, expect, it } from "vitest";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle } from "@market-desk/data-providers";
import { AnalysisMode, CatalystCandidate, ConfidenceResult, MarketSnapshot } from "@market-desk/shared";
import {
  AiUsageTracker,
  CatalystClassifier,
  ConfidenceEngine,
  GeminiAnalystWriter,
  GeminiGenerateClient,
  debugGeminiFromEnv
} from "../src";

describe("GeminiAnalystWriter", () => {
  it("initializes with Gemini status and configured client", () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([]),
      model: "gemini-2.5-flash",
      tracker: new AiUsageTracker()
    });

    expect(writer.getStatus()).toMatchObject({
      provider: "Gemini",
      model: "gemini-2.5-flash",
      fallbackProvider: "template",
      configured: true
    });
  });

  it("uses template fallback when the Gemini API key is missing", async () => {
    const tracker = new AiUsageTracker();
    const writer = new GeminiAnalystWriter({ tracker });
    const draft = await writer.write(await inputForMode("public_telegram"));

    expect(draft.body).toContain("Market commentary only.");
    expect(writer.getStatus().todayAttemptedAiCalls).toBe(0);
    expect(writer.getStatus().todayAiCalls).toBe(0);
    expect(writer.getStatus().todayFallbackCount).toBe(1);
  });

  it("uses template fallback when Gemini errors or rate-limits", async () => {
    const tracker = new AiUsageTracker();
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([], new Error("429 rate limit")),
      tracker
    });
    const draft = await writer.write(await inputForMode("public_telegram"));

    expect(draft.body).toContain("Market commentary only.");
    expect(writer.getStatus().todayAttemptedAiCalls).toBe(1);
    expect(writer.getStatus().todayFallbackCount).toBe(1);
    expect(writer.getStatus().recentUsage[0]?.fallbackUsed).toBe(true);
    expect(writer.getStatus().lastFallbackReason).toContain("429 rate limit");
    expect(writer.getStatus().lastGeminiError).toContain("429 rate limit");
  });

  it("calls Gemini when quote data exists and catalyst is no_confirmed_catalyst", async () => {
    let calls = 0;
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient(
        [
          {
            title: "NVDA no confirmed catalyst",
            body: [
              "NVDA is firmer today. There is no clean confirmed catalyst from available live sources at the time of writing.",
              "The equity read should stay anchored to price action, semiconductor participation, and the broader tech tape because no company-specific headline or filing is confirming the move.",
              "A clearer update would be credible news, a filing, earnings detail, or sector follow-through."
            ].join("\n\n"),
            sourcesUsed: ["src-market-mock"]
          }
        ],
        undefined,
        () => {
          calls += 1;
        }
      ),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("no_confirmed_catalyst"));

    expect(calls).toBe(1);
    expect(draft.body).toContain("NVDA");
    expect(writer.getStatus().todayAttemptedAiCalls).toBe(1);
    expect(writer.getStatus().todayAiCalls).toBe(1);
    expect(writer.getStatus().todayFallbackCount).toBe(0);
  });

  it("does not use template fallback when Gemini succeeds", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "NVDA desk read",
          body: [
            "NVDA is firmer today as earnings context and sector participation support the move.",
            "The move appears linked to data-center demand commentary, with relative volume confirming that the reaction is not just index drift.",
            "The next test is whether the same evidence keeps showing up in sector follow-through and company commentary."
          ].join("\n\n"),
          sourcesUsed: ["src-earnings-nvda"]
        }
      ]),
      tracker: new AiUsageTracker()
    });

    await writer.write(await inputForMode("public_telegram"));

    expect(writer.getStatus().todayAttemptedAiCalls).toBe(1);
    expect(writer.getStatus().todayAiCalls).toBe(1);
    expect(writer.getStatus().todayFallbackCount).toBe(0);
    expect(writer.getStatus().recentUsage[0]?.fallbackUsed).toBe(false);
  });

  it("accepts plain text Gemini public commentary as success", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([publicNvdaText()]),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(draft.body).toContain("NVDA is firmer today");
    expect(draft.body).toMatch(/Market commentary only\.$/);
    expect(status.todaySuccessfulAiCalls).toBe(1);
    expect(status.todayFallbackCount).toBe(0);
    expect(status.lastGeminiSuccess).toBe(true);
    expect(status.lastGeminiRawResponseUsable).toBe(true);
    expect(status.lastGeminiResponseMode).toBe("text");
  });

  it("accepts Gemini JSON with a text field as success", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([{ text: publicNvdaText() }]),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(draft.body).toContain("semiconductor participation");
    expect(status.todaySuccessfulAiCalls).toBe(1);
    expect(status.todayFallbackCount).toBe(0);
    expect(status.lastGeminiResponseMode).toBe("json");
  });

  it("parses markdown fenced Gemini JSON successfully", async () => {
    const fenced = [
      "```json",
      JSON.stringify({ text: publicNvdaText() }),
      "```"
    ].join("\n");
    const client = fakeGeminiClient([fenced]);
    const fencedWriter = new GeminiAnalystWriter({ client, tracker: new AiUsageTracker() });

    const draft = await fencedWriter.write(await inputForMode("public_telegram"));
    const status = fencedWriter.getStatus();

    expect(draft.body).toContain("NVDA is firmer today");
    expect(status.lastGeminiResponseMode).toBe("json");
    expect(status.todayFallbackCount).toBe(0);
  });

  it("recovers malformed Gemini JSON with usable commentary text", async () => {
    const malformed = `{"text":"${publicNvdaText()}`;
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([malformed]),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(draft.body).toContain("NVDA is firmer today");
    expect(status.todaySuccessfulAiCalls).toBe(1);
    expect(status.todayFallbackCount).toBe(0);
    expect(status.lastGeminiJsonParseRecovered).toBe(true);
    expect(status.lastGeminiResponseMode).toBe("text");
  });

  it("uses template fallback when Gemini response is empty", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient(["   "]),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(draft.body).toContain("Market commentary only.");
    expect(status.todaySuccessfulAiCalls).toBe(0);
    expect(status.todayFallbackCount).toBe(1);
    expect(status.lastFallbackReason).toBe("Gemini response was empty.");
  });

  it("returns valid public Telegram output from structured Gemini JSON", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "NVDA desk read",
          body: [
            "NVDA is firmer today as earnings context and sector participation support the move.",
            "The move appears linked to data-center demand commentary, with relative volume confirming that the reaction is not just index drift.",
            "The next test is whether the same evidence keeps showing up in sector follow-through and company commentary."
          ].join("\n\n"),
          sourcesUsed: ["src-earnings-nvda"]
        }
      ]),
      tracker: new AiUsageTracker()
    });
    const draft = await writer.write(await inputForMode("public_telegram"));

    expect(draft.body).toMatch(/Market commentary only\.$/);
    expect(draft.body).not.toMatch(/\bas an ai\b|\bbuy\b|\bsell\b|\bentry\b|\bsignal\b/i);
  });

  it("rejects banned Gemini language by falling back to template copy", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "Bad draft",
          body: "This is a buy signal and a clear entry. Market commentary only.",
          sourcesUsed: ["src-earnings-nvda"]
        }
      ]),
      tracker: new AiUsageTracker()
    });
    const draft = await writer.write(await inputForMode("public_telegram"));

    expect(draft.body).not.toMatch(/\bbuy\b|\bentry\b|\bsignal\b/i);
    expect(writer.getStatus().todayFallbackCount).toBe(1);
  });

  it("supports no_confirmed_catalyst format", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "No confirmed catalyst",
          body: [
            "NVDA is firmer today. There is no clean confirmed catalyst from available live sources at the time of writing.",
            "Price action is visible, but the source set does not confirm a company-specific, macro, earnings, or sector driver.",
            "The next useful update would be a filing, credible news item, earnings detail, or clearer sector confirmation."
          ].join("\n\n"),
          sourcesUsed: ["src-market-mock"]
        }
      ]),
      tracker: new AiUsageTracker()
    });
    const draft = await writer.write(await inputForMode("no_confirmed_catalyst"));

    expect(draft.catalyst.classification).toBe("no_confirmed_catalyst");
    expect(draft.body).toContain("There is no clean confirmed catalyst");
    expect(draft.body).toMatch(/Market commentary only\.$/);
  });

  it("debug Gemini probe makes a small configured test call", async () => {
    const result = await debugGeminiFromEnv(
      {
        GEMINI_API_KEY: "test-gemini-key",
        GEMINI_MODEL_PRIMARY: "gemini-2.5-flash"
      } as NodeJS.ProcessEnv,
      {
        models: {
          async generateContent(input) {
            expect(input.contents).toBe("Reply with exactly: ok");
            return { text: "ok" };
          }
        }
      }
    );

    expect(result).toMatchObject({
      configured: true,
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKeyPresent: true,
      callAttempted: true,
      success: true,
      responseText: "ok",
      fallbackWouldBeUsed: false
    });
  });
});

function fakeGeminiClient(responses: unknown[], error?: Error, onCall?: () => void): GeminiGenerateClient {
  return {
    models: {
      async generateContent() {
        onCall?.();
        if (error) {
          throw error;
        }
        const response = responses.shift();
        return { text: typeof response === "string" ? response : JSON.stringify(response) };
      }
    }
  };
}

function publicNvdaText(): string {
  return [
    "NVDA is firmer today as semiconductor participation supports the move.",
    "The move appears linked to company and sector context, with relative volume giving the reaction more weight than a simple index drift.",
    "The next test is whether fresh company commentary or sector follow-through confirms the move.",
    "Market commentary only."
  ].join("\n\n");
}

async function inputForMode(mode: AnalysisMode) {
  const snapshots = new MarketSnapshotService(createMockProviderBundle());
  const classifier = new CatalystClassifier();
  const confidenceEngine = new ConfidenceEngine();
  const snapshot: MarketSnapshot = await snapshots.getEquitySnapshot("NVDA");

  if (mode === "no_confirmed_catalyst") {
    const weakCatalyst: CatalystCandidate = {
      classification: "no_confirmed_catalyst",
      label: "No confirmed catalyst",
      evidence: [
        {
          sourceId: "src-market-mock",
          kind: "market_data",
          summary: "Price action is available, but source evidence does not confirm a single driver.",
          weight: 0.25
        }
      ],
      confidenceScore: 35,
      sourceIds: ["src-market-mock"],
      explanation: "No source evidence confirms the move."
    };
    const weakConfidence: ConfidenceResult = {
      score: 35,
      band: "weak",
      rationale: "No confirmed catalyst was found in the structured evidence set.",
      requiresReview: true
    };
    return { mode, snapshot, catalysts: [weakCatalyst], confidence: weakConfidence };
  }

  const catalysts = classifier.classify(snapshot);
  return {
    mode,
    snapshot,
    catalysts,
    confidence: confidenceEngine.score(snapshot, catalysts)
  };
}
