import { describe, expect, it } from "vitest";
import { MarketSnapshotService } from "@market-desk/core";
import { createMockProviderBundle } from "@market-desk/data-providers";
import {
  AnalysisMode,
  CatalystCandidate,
  ConfidenceResult,
  MarketSnapshot
} from "@market-desk/shared";
import {
  CatalystClassifier,
  ConfidenceEngine,
  MockAnalystWriter,
  StyleValidationError,
  analystPromptLibrary,
  buildAnalystPromptInput,
  validateAnalystStyle
} from "../src";

const requiredModes: AnalysisMode[] = [
  "public_telegram",
  "x_short",
  "private_research",
  "macro_reaction",
  "earnings_reaction",
  "no_confirmed_catalyst",
  "commodity_reaction",
  "forex_reaction",
  "equity_mover_reaction"
];

const bannedPublicPatterns = [
  /\bas an ai\b/i,
  /\bit is important to note\b/i,
  /\binvestors are optimistic\b/i,
  /\bbuy\b/i,
  /\bsell\b/i,
  /\bentry\b/i,
  /\bsignal\b/i,
  /\bguaranteed\b/i,
  /\brisk-free\b/i,
  /\beasy money\b/i,
  /\bnot financial advice\b/i,
  /\bmock\b/i,
  /\bsource ids?\b/i,
  /\bjson\b/i,
  /\bstructured feed\b/i,
  /^(summary|analysis|market update|key takeaway|conclusion|overview):/im
];

describe("analyst prompt library", () => {
  const snapshots = new MarketSnapshotService(createMockProviderBundle());
  const classifier = new CatalystClassifier();
  const confidenceEngine = new ConfidenceEngine();
  const writer = new MockAnalystWriter();

  it("defines prompts and schemas for every requested mode", async () => {
    const equitySnapshot = await snapshots.getEquitySnapshot("NVDA");
    const catalysts = classifier.classify(equitySnapshot);
    const confidence = confidenceEngine.score(equitySnapshot, catalysts);

    for (const mode of requiredModes) {
      const definition = analystPromptLibrary[mode];
      expect(definition.systemPrompt.length).toBeGreaterThan(80);
      expect(definition.userPromptTemplate).toBeTypeOf("function");
      expect(definition.inputSchema.safeParse(buildAnalystPromptInput({ mode, snapshot: equitySnapshot, catalysts, confidence })).success).toBe(
        true
      );
      expect(definition.outputSchema.safeParse({ title: "Desk note", body: "Evidence-led desk commentary.", sourcesUsed: ["src-market-mock"] }).success).toBe(
        true
      );
      expect(definition.outputJsonSchema.required).toEqual(["title", "body", "sourcesUsed"]);
    }
  });

  it("produces concise style-valid commentary without banned phrases in every requested mode", async () => {
    for (const mode of requiredModes) {
      const input = await inputForMode(mode, snapshots, classifier, confidenceEngine);
      const draft = await writer.write(input);
      const style = validateAnalystStyle(draft.body, {
        mode,
        sourceIds: draft.sourcesUsed,
        evidenceSummaries: draft.catalyst.evidence.map((item) => item.summary)
      });

      expect(style.ok).toBe(true);
      expect(draft.body.length).toBeLessThanOrEqual(mode === "x_short" ? 280 : 2200);
      for (const pattern of bannedPublicPatterns) {
        expect(draft.body).not.toMatch(pattern);
      }

      if (mode !== "private_research") {
        expect(draft.body.match(/Market commentary only\./g)).toHaveLength(1);
      }
    }
  });

  it("rejects generic, unsupported, advice-like, and repetitive disclaimer language", () => {
    const badText = [
      "As an AI, it is important to note that investors are optimistic.",
      "This is a buy signal with a clear entry and guaranteed upside.",
      "Stocks are shares in a company, and this is not financial advice.",
      "This JSON came from a mock structured feed with source IDs.",
      "Market commentary only.",
      "Market commentary only."
    ].join("\n");

    const result = validateAnalystStyle(badText, { mode: "public_telegram", evidenceSummaries: [] });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "generic_phrase",
        "unsupported_sentiment",
        "trading_language",
        "unsupported_certainty",
        "over_explaining",
        "internal_artifact",
        "repetitive_disclaimer"
      ])
    );
    expect(() => {
      throw new StyleValidationError(result.issues);
    }).toThrow("Analyst style validation failed");
  });
});

async function inputForMode(
  mode: AnalysisMode,
  snapshots: MarketSnapshotService,
  classifier: CatalystClassifier,
  confidenceEngine: ConfidenceEngine
) {
  let snapshot: MarketSnapshot;
  if (mode === "commodity_reaction") {
    snapshot = await snapshots.getCommoditySnapshot("OIL");
  } else if (mode === "forex_reaction" || mode === "macro_reaction") {
    snapshot = await snapshots.getForexSnapshot("EURUSD");
  } else {
    snapshot = await snapshots.getEquitySnapshot("NVDA");
  }

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

    return {
      mode,
      snapshot,
      catalysts: [weakCatalyst],
      confidence: weakConfidence
    };
  }

  const catalysts = classifier.classify(snapshot);
  return {
    mode,
    snapshot,
    catalysts,
    confidence: confidenceEngine.score(snapshot, catalysts)
  };
}
