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
  debugGeminiFromEnv,
  evaluatePublicOutputQuality
} from "../src";
import { formatMove as promptFormatMove } from "../src/prompts/build-input";

describe("GeminiAnalystWriter", () => {
  it("formats price direction without misleading signs", () => {
    expect(promptFormatMove(-4.42)).toBe("lower by 4.42%");
    expect(promptFormatMove(2.1)).toBe("higher by 2.10%");
    expect(promptFormatMove(-0.05)).toBe("little changed");
  });

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
              "NVDA is firmer today, with live pricing showing a clear move in the stock.",
              "There is no confirmed company-specific catalyst from current live sources, so the cleaner read is that price action is being shaped by semiconductor participation, broader tech tape positioning, and index context rather than a standalone NVDA event.",
              "The next check is whether Nasdaq direction, chip-sector breadth, fresh company commentary, or official filings confirm the move.",
              "Market commentary only."
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
    const status = writer.getStatus();

    expect(calls).toBe(1);
    expect(draft.body).toContain("NVDA");
    expect(writer.getStatus().todayAttemptedAiCalls).toBe(1);
    expect(writer.getStatus().todayAiCalls).toBe(1);
    expect(writer.getStatus().todayFallbackCount).toBe(0);
    expect(status.lastOriginalGeminiQualityPassed).toBe(true);
    expect(status.lastQualityRewriteAttempted).toBe(false);
    expect(status.lastFinalWriterUsed).toBe("gemini");
  });

  it("does not use template fallback when Gemini succeeds", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "NVDA desk read",
          body: publicNvdaText(),
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

  it("rewrites shallow Gemini public output once", async () => {
    let calls = 0;
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient(
        [
          "NVIDIA shares declined 4.42% on volume of 179,993,300.\n\nMarket commentary only.",
          publicNvdaText()
        ],
        undefined,
        () => {
          calls += 1;
        }
      ),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(calls).toBe(2);
    expect(draft.body).toContain("The next test");
    expect(draft.body.split(/\s+/).length).toBeGreaterThanOrEqual(55);
    expect(status.lastGeminiOriginalOutputWordCount).toBeLessThan(55);
    expect(status.lastGeminiRewriteOutputWordCount).toBeGreaterThanOrEqual(55);
    expect(status.lastFinalOutputWordCount).toBeGreaterThanOrEqual(55);
    expect(status.lastQualityTextEvaluatedSource).toBe("rewrite");
    expect(status.lastQualityFailureReasons).toContain("fewer than 55 words");
    expect(status.todayFallbackCount).toBe(0);
    expect(status.lastQualityCheckResult?.ok).toBe(true);
    expect(status.lastQualityRewriteAttempted).toBe(true);
    expect(status.lastQualityRewritePassed).toBe(true);
    expect(status.lastFinalWriterUsed).toBe("gemini");
  });

  it("sends a three-paragraph public note instruction to Gemini", async () => {
    let prompt = "";
    const writer = new GeminiAnalystWriter({
      client: {
        models: {
          async generateContent(input) {
            prompt = String(input.contents);
            return { text: publicNvdaText() };
          }
        }
      },
      tracker: new AiUsageTracker()
    });

    await writer.write(await inputForMode("public_telegram"));

    expect(prompt).toContain("Write a concise senior market analyst note in 3 short paragraphs plus the final line.");
    expect(prompt).toContain("Length: 85-150 words.");
    expect(prompt).toContain("Do not return a one-line summary.");
  });

  it("does not attempt a quality rewrite when original Gemini output passes", async () => {
    let calls = 0;
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([publicNvdaText(), "This response should not be requested."], undefined, () => {
        calls += 1;
      }),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(calls).toBe(1);
    expect(draft.body).toContain("NVDA is firmer today");
    expect(status.lastOriginalGeminiQualityPassed).toBe(true);
    expect(status.lastQualityRewriteAttempted).toBe(false);
    expect(status.lastQualityRewritePassed).toBe(false);
    expect(status.lastFinalWriterUsed).toBe("gemini");
    expect(status.lastFallbackReason).toBeUndefined();
    expect(status.lastQualityTextEvaluatedSource).toBe("original");
    expect(status.lastQualityFailureReasons).toEqual([]);
    expect(status.todayFallbackCount).toBe(0);
  });

  it("uses template fallback only when original and rewrite both fail quality", async () => {
    let calls = 0;
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient(
        [
          "NVDA declined 4.42%.\n\nMarket commentary only.",
          "NVDA declined again.\n\nMarket commentary only."
        ],
        undefined,
        () => {
          calls += 1;
        }
      ),
      tracker: new AiUsageTracker()
    });

    const draft = await writer.write(await inputForMode("public_telegram"));
    const status = writer.getStatus();

    expect(calls).toBe(2);
    expect(draft.body).toContain("Market commentary only.");
    expect(status.lastOriginalGeminiQualityPassed).toBe(false);
    expect(status.lastQualityRewriteAttempted).toBe(true);
    expect(status.lastQualityRewritePassed).toBe(false);
    expect(status.lastFinalWriterUsed).toBe("template");
    expect(status.lastGeminiSuccess).toBe(false);
    expect(status.todayFallbackCount).toBe(1);
    expect(status.lastFallbackReason).toMatch(/Gemini rewrite was too shallow|Gemini output was too shallow/);
  });

  it("returns valid public Telegram output from structured Gemini JSON", async () => {
    const writer = new GeminiAnalystWriter({
      client: fakeGeminiClient([
        {
          title: "NVDA desk read",
          body: publicNvdaText(),
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
            "NVDA is firmer today, with live pricing showing a clear move in the stock.",
            "There is no confirmed company-specific catalyst in current live sources, so the cleaner read is positioning and broader tape participation rather than a standalone event.",
            "The next check is whether a filing, credible company news, earnings detail, or clearer sector confirmation improves the explanation."
          ].join("\n\n"),
          sourcesUsed: ["src-market-mock"]
        }
      ]),
      tracker: new AiUsageTracker()
    });
    const draft = await writer.write(await inputForMode("no_confirmed_catalyst"));

    expect(draft.catalyst.classification).toBe("no_confirmed_catalyst");
    expect(draft.body).toContain("There is no confirmed company-specific catalyst");
    expect(draft.body).toMatch(/Market commentary only\.$/);
  });

  it("accepts next-clean-read language as a valid forward-looking check", () => {
    const text = [
      "Gold is little changed today rather than directionally weak, with live pricing showing a muted move near flat.",
      "There is no clean confirmed catalyst from current live sources, so the cleaner read is consolidation while the market still needs direction from DXY, Treasury yields, Fed expectations, inflation data, or safe-haven demand.",
      "The next clean read comes from whether DXY and yields break directionally after incoming US macro data.",
      "Market commentary only."
    ].join("\n\n");

    const quality = evaluatePublicOutputQuality(text, "commodity_reaction");

    expect(quality.ok).toBe(true);
    expect(quality.hasWhatMattersNext).toBe(true);
    expect(quality.wordCount).toBeGreaterThanOrEqual(55);
  });

  it("accepts next-check language as a valid catalyst/watch factor", () => {
    const text = [
      "NVDA is lower today, with live pricing showing a 4.42% decline on heavy volume.",
      "There is no confirmed company-specific catalyst in current live sources, so the cleaner read is that the move is being shaped by broader tape pressure, positioning, or semiconductor participation. The wider market context matters here because tech weakness can amplify single-name moves.",
      "The next check is whether the weakness is confirmed by Nasdaq direction, semiconductor breadth, fresh AI-chip demand commentary, or company-specific news.",
      "Market commentary only."
    ].join("\n\n");

    const quality = evaluatePublicOutputQuality(text, "equity_mover_reaction");

    expect(quality.ok).toBe(true);
    expect(quality.hasWhatMattersNext).toBe(true);
  });

  it("uses little-changed language for tiny GOLD moves in template fallback", async () => {
    const writer = new GeminiAnalystWriter({ tracker: new AiUsageTracker() });
    const draft = await writer.write(await commodityInputForGoldMove(-0.05));

    expect(draft.body).toContain("little changed");
    expect(draft.body).not.toMatch(/\bsofter\b|\bweaker\b/i);
    expect(draft.body).toMatch(/Market commentary only\.$/);
  });

  it("NVDA no-catalyst fallback avoids mechanical analyst phrases", async () => {
    const writer = new GeminiAnalystWriter({ tracker: new AiUsageTracker() });
    const draft = await writer.write(await inputForMode("no_confirmed_catalyst"));

    expect(draft.body).toContain("There is no confirmed company-specific catalyst");
    expect(draft.body).toContain("The next check is");
    expect(draft.body).not.toMatch(
      /the index read is|the useful read is|the right stance is caution|the desk would need|available live sources at the time of writing|source set does not provide enough support|standalone confirmed story/i
    );
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
    "NVDA is firmer today, with live pricing showing a clear move in the stock and volume giving the reaction more weight than a simple quote update.",
    "The cleaner read is that semiconductor participation, index context, and company-specific evidence need to be considered together before treating the move as a standalone NVDA story.",
    "The next test is whether fresh company commentary, sector breadth, Nasdaq direction, or official filings confirm the move.",
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

async function commodityInputForGoldMove(percentChange: number) {
  const base = createMockProviderBundle();
  const snapshots = new MarketSnapshotService({
    ...base,
    marketData: {
      ...base.marketData,
      async getCommodityQuote() {
        return {
          symbol: "GOLD",
          assetClass: "commodity" as const,
          price: 2400,
          percentChange,
          sourceId: "src-twelve-gold",
          sourceName: "twelve_data",
          asOf: new Date().toISOString()
        };
      }
    }
  });
  const snapshot = await snapshots.getCommoditySnapshot("GOLD");
  const weakCatalyst: CatalystCandidate = {
    classification: "no_confirmed_catalyst",
    label: "No confirmed catalyst",
    evidence: [
      {
        sourceId: "src-twelve-gold",
        kind: "market_data",
        summary: "Live quote data is available, but source evidence does not confirm a clean catalyst.",
        weight: 0.25
      }
    ],
    confidenceScore: 35,
    sourceIds: ["src-twelve-gold"],
    explanation: "No source evidence confirms the move."
  };
  const weakConfidence: ConfidenceResult = {
    score: 35,
    band: "weak",
    rationale: "No confirmed catalyst was found in the structured evidence set.",
    requiresReview: true
  };
  return { mode: "commodity_reaction" as const, snapshot, catalysts: [weakCatalyst], confidence: weakConfidence };
}
