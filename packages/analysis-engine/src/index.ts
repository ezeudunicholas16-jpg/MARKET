import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { ComplianceEngine, ComplianceResult, ensurePublicDisclaimer } from "@market-desk/compliance";
import { MarketSnapshotService } from "@market-desk/core";
import {
  AnalysisDraft,
  AnalysisMode,
  CatalystCandidate,
  CatalystClassification,
  ConfidenceResult,
  MarketSnapshot,
  SourceEvidence,
  analysisDraftSchema
} from "@market-desk/shared";
import {
  assertAnalystStyle,
  buildAnalystPromptInput,
  formatMove as promptFormatMove,
  getAnalystPromptDefinition,
  isPublicMode,
  snapshotMove as promptSnapshotMove,
  validateAnalystStyle
} from "./prompts";

export * from "./prompts";
export * from "./publishing";

export class CatalystClassifier {
  classify(snapshot: MarketSnapshot): CatalystCandidate[] {
    if (hasLiveSourceWarning(snapshot)) {
      return [this.noConfirmedCatalyst(snapshot)];
    }

    const candidates =
      snapshot.assetClass === "equity"
        ? this.classifyEquity(snapshot)
        : snapshot.assetClass === "forex"
          ? this.classifyForex(snapshot)
          : this.classifyCommodity(snapshot);

    const sorted = this.withMixedCandidate(candidates).sort((a, b) => b.confidenceScore - a.confidenceScore);
    return sorted.length > 0 ? sorted : [this.noConfirmedCatalyst(snapshot)];
  }

  private classifyEquity(snapshot: Extract<MarketSnapshot, { assetClass: "equity" }>): CatalystCandidate[] {
    const candidates: CatalystCandidate[] = [];

    if (snapshot.earningsContext?.sourceId) {
      candidates.push(
        this.candidate({
          classification: "earnings_related",
          label: "Earnings and guidance context",
          explanation: "Earnings context is present, including surprise metrics or guidance commentary.",
          confidenceScore: 92,
          evidence: [
            {
              sourceId: snapshot.earningsContext.sourceId,
              kind: "earnings",
              summary: snapshot.earningsContext.guidance ?? "Earnings context supplied by provider.",
              weight: 0.95
            }
          ]
        })
      );
    }

    for (const filing of snapshot.latestFilings) {
      candidates.push(
        this.candidate({
          classification: "company_specific",
          label: `${snapshot.symbol} official filing`,
          explanation: "An official filing is available and can directly explain company-specific attention.",
          confidenceScore: 94,
          evidence: [
            {
              sourceId: filing.sourceId,
              kind: "filing",
              summary: `${filing.filingType}: ${filing.title}`,
              weight: 0.98
            }
          ]
        })
      );
    }

    for (const item of snapshot.latestNews) {
      const headline = item.headline.toLowerCase();
      const baseEvidence: SourceEvidence = {
        sourceId: item.sourceId,
        kind: "headline",
        summary: item.summary ?? item.headline,
        weight: 0.75
      };

      if (/earnings|guidance|eps|revenue|margin/.test(headline)) {
        candidates.push(
          this.candidate({
            classification: "earnings_related",
            label: "Earnings or guidance read-through",
            explanation: "News flow directly references earnings, guidance, revenue, or margin inputs.",
            confidenceScore: 84,
            evidence: [baseEvidence]
          })
        );
      }

      if (/analyst|upgrade|downgrade|price target|coverage/.test(headline)) {
        candidates.push(
          this.candidate({
            classification: "analyst_action",
            label: "Analyst action",
            explanation: "News flow references an analyst rating, coverage, or target change.",
            confidenceScore: 82,
            evidence: [baseEvidence]
          })
        );
      }

      if (/acquir|merger|partnership|joint venture|stake/.test(headline)) {
        candidates.push(
          this.candidate({
            classification: "mna_or_partnership",
            label: "M&A or partnership catalyst",
            explanation: "News flow references a transaction, stake, or partnership.",
            confidenceScore: 86,
            evidence: [baseEvidence]
          })
        );
      }

      if (/regulator|regulatory|lawsuit|sec|ftc|probe|inquiry|antitrust/.test(headline)) {
        candidates.push(
          this.candidate({
            classification: "regulatory_or_legal",
            label: "Regulatory or legal catalyst",
            explanation: "News flow references regulatory or legal developments.",
            confidenceScore: 86,
            evidence: [baseEvidence]
          })
        );
      }

      if (/capex|demand|delivery|pricing|shipment|order/.test(headline)) {
        candidates.push(
          this.candidate({
            classification: "company_specific",
            label: "Company-specific operating catalyst",
            explanation: "News flow references demand, pricing, deliveries, or order activity.",
            confidenceScore: 76,
            evidence: [baseEvidence]
          })
        );
      }
    }

    if (Math.abs(snapshot.sectorMove) >= 1.5 && sameDirection(snapshot.percentChange, snapshot.sectorMove)) {
      candidates.push(
        this.candidate({
          classification: "sector_wide",
          label: `${snapshot.sector} sector move`,
          explanation: "The stock move is aligned with a larger sector move.",
          confidenceScore: 74,
          evidence: [
            {
              sourceId: "src-market-mock",
              kind: "market_data",
              summary: `${snapshot.sector} is ${formatMove(snapshot.sectorMove)} while ${snapshot.symbol} is ${formatMove(snapshot.percentChange)}.`,
              weight: 0.65
            }
          ]
        })
      );
    }

    if (Math.abs(snapshot.indexMove) >= 1 && sameDirection(snapshot.percentChange, snapshot.indexMove)) {
      candidates.push(
        this.candidate({
          classification: "macro_driven",
          label: "Index-led move",
          explanation: "The stock move is aligned with broad index direction.",
          confidenceScore: 68,
          evidence: [
            {
              sourceId: "src-market-mock",
              kind: "market_data",
              summary: `Index context is ${formatMove(snapshot.indexMove)} versus ${snapshot.symbol} at ${formatMove(snapshot.percentChange)}.`,
              weight: 0.55
            }
          ]
        })
      );
    }

    return candidates;
  }

  private classifyForex(snapshot: Extract<MarketSnapshot, { assetClass: "forex" }>): CatalystCandidate[] {
    const candidates: CatalystCandidate[] = [];
    const macroEvents = snapshot.macroEvents.filter((event) => event.importance === "high");

    candidates.push(
      this.candidate({
        classification: "fx_rate_expectation",
        label: "Rate-path and dollar context",
        explanation: "FX move is framed by dollar direction, yield context, and central-bank rate expectations.",
        confidenceScore: 72,
        evidence: [
          {
            sourceId: snapshot.dxyContext.sourceId ?? "src-macro-us",
            kind: "macro_release",
            summary: snapshot.dxyContext.value,
            weight: 0.7
          },
          {
            sourceId: snapshot.centralBankContext.sourceId ?? "src-macro-us",
            kind: "provider_note",
            summary: snapshot.centralBankContext.value,
            weight: 0.65
          }
        ]
      })
    );

    if (macroEvents.length > 0) {
      candidates.push(
        this.candidate({
          classification: "macro_driven",
          label: "High-importance macro calendar",
          explanation: "High-importance macro events are active in the FX snapshot.",
          confidenceScore: 70,
          evidence: macroEvents.map((event) => ({
            sourceId: event.sourceId,
            kind: "macro_release",
            summary: `${event.name}: consensus ${event.consensus ?? "n/a"}, prior ${event.prior ?? "n/a"}`,
            weight: 0.6
          }))
        })
      );
    }

    return candidates;
  }

  private classifyCommodity(snapshot: Extract<MarketSnapshot, { assetClass: "commodity" }>): CatalystCandidate[] {
    const candidates: CatalystCandidate[] = [];

    if (snapshot.inventoryContext.bias !== "neutral" || snapshot.supplyDemandContext.bias !== "neutral") {
      candidates.push(
        this.candidate({
          classification: "commodity_supply_demand",
          label: "Supply-demand and inventory context",
          explanation: "Commodity move is linked to inventory or supply-demand information in the structured feed.",
          confidenceScore: snapshot.inventoryContext.sourceId === "src-commodity-eia" ? 86 : 72,
          evidence: [
            {
              sourceId: snapshot.inventoryContext.sourceId ?? "src-market-mock",
              kind: "provider_note",
              summary: snapshot.inventoryContext.value,
              weight: 0.78
            },
            {
              sourceId: snapshot.supplyDemandContext.sourceId ?? "src-market-mock",
              kind: "provider_note",
              summary: snapshot.supplyDemandContext.value,
              weight: 0.7
            }
          ]
        })
      );
    }

    if (snapshot.dollarContext.bias !== "neutral" || snapshot.yieldContext.bias !== "neutral") {
      candidates.push(
        this.candidate({
          classification: "macro_driven",
          label: "Dollar and yield context",
          explanation: "The commodity move is being filtered through dollar and yield inputs.",
          confidenceScore: 66,
          evidence: [
            {
              sourceId: snapshot.dollarContext.sourceId ?? "src-macro-us",
              kind: "macro_release",
              summary: snapshot.dollarContext.value,
              weight: 0.55
            },
            {
              sourceId: snapshot.yieldContext.sourceId ?? "src-macro-us",
              kind: "macro_release",
              summary: snapshot.yieldContext.value,
              weight: 0.5
            }
          ]
        })
      );
    }

    return candidates;
  }

  private withMixedCandidate(candidates: CatalystCandidate[]): CatalystCandidate[] {
    const strong = candidates.filter((candidate) => candidate.confidenceScore >= 70);
    const classifications = new Set(strong.map((candidate) => candidate.classification));
    if (classifications.size < 2) {
      return candidates;
    }

    const evidence = strong.flatMap((candidate) => candidate.evidence).slice(0, 4);
    return [
      ...candidates,
      this.candidate({
        classification: "mixed",
        label: "Mixed catalyst set",
        explanation: "Multiple supported catalyst categories are active, so the move should not be reduced to a single driver.",
        confidenceScore: Math.min(89, Math.max(...strong.map((candidate) => candidate.confidenceScore))),
        evidence
      })
    ];
  }

  private noConfirmedCatalyst(snapshot: MarketSnapshot): CatalystCandidate {
    const label =
      snapshot.assetClass === "equity"
        ? `${snapshot.symbol} no confirmed catalyst`
        : snapshot.assetClass === "forex"
          ? `${snapshot.pair} no confirmed catalyst`
          : `${snapshot.asset} no confirmed catalyst`;

    const evidenceSourceId =
      hasLiveSourceWarning(snapshot)
        ? "src-live-source-warning"
        : snapshot.sources.find((source) => source.type === "market_data")?.id ?? snapshot.sources[0]?.id ?? "src-market-mock";

    return this.candidate({
      classification: "no_confirmed_catalyst",
      label,
      explanation: "There is no confirmed catalyst in the current live sources.",
      confidenceScore: 35,
      evidence: [
        {
          sourceId: evidenceSourceId,
          kind: "market_data",
          summary: "There is no confirmed catalyst in the current live sources.",
          weight: 0.25
        }
      ]
    });
  }

  private candidate(input: {
    classification: CatalystClassification;
    label: string;
    explanation: string;
    confidenceScore: number;
    evidence: SourceEvidence[];
  }): CatalystCandidate {
    return {
      ...input,
      sourceIds: [...new Set(input.evidence.map((item) => item.sourceId))]
    };
  }
}

export class ConfidenceEngine {
  score(snapshot: MarketSnapshot, catalysts: CatalystCandidate[]): ConfidenceResult {
    const top = catalysts[0];
    if (!top || top.classification === "no_confirmed_catalyst") {
      return {
        score: 35,
        band: "weak",
        rationale: "No confirmed catalyst was found in the structured evidence set.",
        requiresReview: true
      };
    }

    const officialSource = snapshot.sources.some(
      (source) => top.sourceIds.includes(source.id) && (source.type === "official" || source.type === "earnings")
    );
    const multiSource = top.sourceIds.length >= 2;

    if (officialSource && top.confidenceScore >= 85) {
      return {
        score: Math.max(90, top.confidenceScore),
        band: "confirmed",
        rationale: "Confirmed by official filing, earnings release, economic release, or direct announcement.",
        requiresReview: false
      };
    }

    if (top.confidenceScore >= 70 && (multiSource || Math.abs(snapshotMove(snapshot)) >= 1)) {
      return {
        score: Math.min(89, Math.max(70, top.confidenceScore)),
        band: "strong",
        rationale: "Strong alignment across source evidence and market movement.",
        requiresReview: false
      };
    }

    if (top.confidenceScore >= 50) {
      return {
        score: Math.min(69, top.confidenceScore),
        band: "interpretive",
        rationale: "Reasonable market interpretation, but not fully confirmed by source evidence.",
        requiresReview: false
      };
    }

    return {
      score: Math.max(0, top.confidenceScore),
      band: "weak",
      rationale: "Weak sourcing or weak causal link; use cautious language or hold for review.",
      requiresReview: true
    };
  }
}

export interface AnalystWritingInput {
  mode: AnalysisMode;
  snapshot: MarketSnapshot;
  catalysts: CatalystCandidate[];
  confidence: ConfidenceResult;
}

export interface AiUsageRecord {
  providerName: string;
  model: string;
  promptTokenEstimate: number;
  outputTokenEstimate: number;
  success: boolean;
  fallbackUsed: boolean;
  callAttempted: boolean;
  rawResponseUsable?: boolean;
  jsonParseRecovered?: boolean;
  responseMode?: "text" | "json";
  qualityCheckResult?: PublicOutputQualityResult;
  originalGeminiQualityPassed?: boolean;
  qualityRewriteAttempted?: boolean;
  qualityRewritePassed?: boolean;
  finalWriterUsed?: "gemini" | "template";
  originalGeminiWordCount?: number;
  rewriteGeminiWordCount?: number;
  finalOutputWordCount?: number;
  qualityFailureReasons?: string[];
  qualityTextEvaluatedSource?: "original" | "rewrite" | "final";
  timestamp: string;
  error?: string;
  fallbackReason?: string;
}

export interface AiProviderStatus {
  provider: string;
  model: string;
  fallbackProvider: string;
  configured: boolean;
  todayAiCalls: number;
  todayAttemptedAiCalls: number;
  todaySuccessfulAiCalls: number;
  todayFallbackCount: number;
  maxGenerationsPerDay: number;
  recentUsage: AiUsageRecord[];
  lastProviderUsed?: string;
  lastProviderAttempted?: string;
  lastCallAttempted?: boolean;
  lastGeminiSuccess?: boolean;
  lastGeminiRawResponseUsable?: boolean;
  lastGeminiJsonParseRecovered?: boolean;
  lastGeminiResponseMode?: "text" | "json";
  lastQualityCheckResult?: PublicOutputQualityResult;
  lastOriginalGeminiQualityPassed?: boolean;
  lastQualityCheckPassed?: boolean;
  lastQualityRewriteAttempted?: boolean;
  lastQualityRewritePassed?: boolean;
  lastFinalWriterUsed?: "gemini" | "template";
  lastGeminiOriginalOutputWordCount?: number;
  lastGeminiRewriteOutputWordCount?: number;
  lastFinalOutputWordCount?: number;
  lastQualityFailureReasons?: string[];
  lastQualityTextEvaluatedSource?: "original" | "rewrite" | "final";
  lastFallbackReason?: string;
  lastGeminiError?: string;
  geminiConfigured?: boolean;
}

export interface PublicOutputQualityResult {
  ok: boolean;
  wordCount: number;
  paragraphCount: number;
  hasAssetMove: boolean;
  hasInterpretation: boolean;
  hasWhatMattersNext: boolean;
  endsWithFooter: boolean;
  hasBannedTradingAdvice: boolean;
  reasons: string[];
}

export class AiUsageTracker {
  private readonly records: AiUsageRecord[] = [];

  record(record: Omit<AiUsageRecord, "timestamp"> & { timestamp?: string }): AiUsageRecord {
    const saved = {
      ...record,
      timestamp: record.timestamp ?? new Date().toISOString()
    };
    this.records.push(saved);
    return saved;
  }

  list(): AiUsageRecord[] {
    return [...this.records];
  }

  today(providerName?: string): AiUsageRecord[] {
    const start = startOfUtcDay().getTime();
    return this.records.filter((record) => {
      const matchesProvider = providerName ? record.providerName === providerName : true;
      return matchesProvider && new Date(record.timestamp).getTime() >= start;
    });
  }
}

export const defaultAiUsageTracker = new AiUsageTracker();

export interface AnalystWriter {
  write(input: AnalystWritingInput): Promise<AnalysisDraft>;
  getStatus?(): AiProviderStatus;
}

export class OpenAIAnalystWriter implements AnalystWriter {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  getStatus(): AiProviderStatus {
    return {
      provider: "openai",
      model: this.model,
      fallbackProvider: "template",
      configured: true,
      todayAiCalls: 0,
      todayAttemptedAiCalls: 0,
      todaySuccessfulAiCalls: 0,
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: [],
      lastProviderUsed: "openai",
      lastProviderAttempted: "none",
      lastCallAttempted: false,
      lastGeminiRawResponseUsable: false,
      lastGeminiJsonParseRecovered: false,
      lastGeminiResponseMode: "text",
      lastQualityCheckResult: undefined,
      lastOriginalGeminiQualityPassed: undefined,
      lastQualityCheckPassed: undefined,
      lastQualityRewriteAttempted: false,
      lastQualityRewritePassed: false,
      lastFinalWriterUsed: undefined
    };
  }

  async write(input: AnalystWritingInput): Promise<AnalysisDraft> {
    const top = input.catalysts[0];
    if (!top) {
      throw new Error("Cannot write analysis without a catalyst candidate.");
    }

    const promptDefinition = getAnalystPromptDefinition(input.mode);
    const promptInput = buildAnalystPromptInput(input);
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "system",
          content: promptDefinition.systemPrompt
        },
        {
          role: "user",
          content: promptDefinition.userPromptTemplate(promptInput)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "analyst_commentary",
          strict: true,
          schema: promptDefinition.outputJsonSchema
        }
      }
    } as any);

    const raw = (response as { output_text?: string }).output_text;
    if (!raw) {
      throw new Error("OpenAI response did not include output_text.");
    }

    const parsed = promptDefinition.outputSchema.parse(JSON.parse(raw));
    const body = promptDefinition.publicOutput ? ensurePublicDisclaimer(parsed.body) : parsed.body;
    assertAnalystStyle(body, {
      mode: input.mode,
      sourceIds: parsed.sourcesUsed,
      evidenceSummaries: [...promptInput.evidence.map((item) => item.summary), ...promptInput.facts]
    });

    return analysisDraftSchema.parse({
      mode: input.mode,
      title: parsed.title,
      body,
      confidence: input.confidence,
      catalyst: top,
      sourcesUsed: parsed.sourcesUsed
    });
  }
}

export class MockAnalystWriter implements AnalystWriter {
  getStatus(): AiProviderStatus {
    return {
      provider: "template",
      model: "template",
      fallbackProvider: "template",
      configured: true,
      todayAiCalls: 0,
      todayAttemptedAiCalls: 0,
      todaySuccessfulAiCalls: 0,
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: [],
      lastProviderUsed: "template",
      lastProviderAttempted: "none",
      lastCallAttempted: false,
      lastGeminiSuccess: false,
      lastGeminiRawResponseUsable: false,
      lastGeminiJsonParseRecovered: false,
      lastGeminiResponseMode: "text",
      lastQualityCheckResult: undefined,
      lastOriginalGeminiQualityPassed: undefined,
      lastQualityCheckPassed: undefined,
      lastQualityRewriteAttempted: false,
      lastQualityRewritePassed: false,
      lastFinalWriterUsed: "template",
      lastFallbackReason: "template writer selected"
    };
  }

  async write(input: AnalystWritingInput): Promise<AnalysisDraft> {
    const top = input.catalysts[0];
    if (!top) {
      throw new Error("Cannot write analysis without a catalyst candidate.");
    }

    const promptDefinition = getAnalystPromptDefinition(input.mode);
    const promptInput = buildAnalystPromptInput(input);
    let body = this.bodyForMode(input.mode, promptInput);

    if (promptDefinition.publicOutput) {
      body = ensurePublicDisclaimer(body);
    }

    const parsed = promptDefinition.outputSchema.parse({
      title: `${promptInput.subject}: ${top.label}`,
      body,
      sourcesUsed: top.sourceIds.length > 0 ? top.sourceIds : ["src-market-mock"]
    });

    assertAnalystStyle(parsed.body, {
      mode: input.mode,
      sourceIds: parsed.sourcesUsed,
      evidenceSummaries: [...promptInput.evidence.map((item) => item.summary), ...promptInput.facts]
    });

    return analysisDraftSchema.parse({
      mode: input.mode,
      title: parsed.title,
      body: parsed.body,
      confidence: input.confidence,
      catalyst: top,
      sourcesUsed: parsed.sourcesUsed
    });
  }

  private bodyForMode(mode: AnalysisMode, input: ReturnType<typeof buildAnalystPromptInput>): string {
    if (mode === "x_short") {
      return this.xShort(input);
    }

    if (mode === "private_research") {
      return this.privateResearch(input);
    }

    if (mode === "dashboard_brief") {
      return this.dashboardBrief(input);
    }

    if (mode === "no_confirmed_catalyst" || input.primaryCatalyst.classification === "no_confirmed_catalyst") {
      return this.noConfirmedCatalyst(input);
    }

    if (mode === "commodity_reaction" || input.snapshot.assetClass === "commodity") {
      return this.commodityReaction(input);
    }

    if (mode === "forex_reaction" || input.snapshot.assetClass === "forex") {
      return this.forexReaction(input);
    }

    if (mode === "earnings_reaction") {
      return this.earningsReaction(input);
    }

    if (mode === "macro_reaction") {
      return this.macroReaction(input);
    }

    if (mode === "equity_mover_reaction") {
      return this.equityMoverReaction(input);
    }

    return this.publicTelegram(input);
  }

  private publicTelegram(input: ReturnType<typeof buildAnalystPromptInput>): string {
    return [
      `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}.`,
      `The move appears linked to ${input.primaryCatalyst.label.toLowerCase()}. ${this.evidenceLine(input)}`,
      `The cleaner read is that price action should be checked against the available catalyst evidence and broader market context before assigning confidence at ${input.confidence.score}/100.`,
      `The next catalyst is whether fresh data confirms the current read or challenges it through the dollar, yields, sector direction, or company-specific news flow.`
    ].join("\n\n");
  }

  private xShort(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const body = `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}; ${input.primaryCatalyst.label.toLowerCase()} is the clearest supported driver. Market commentary only.`;
    return body.length <= 280 ? body : `${input.subject}: move tied to ${input.primaryCatalyst.label.toLowerCase()}. Market commentary only.`;
  }

  private privateResearch(input: ReturnType<typeof buildAnalystPromptInput>): string {
    return [
      `Desk View\n${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}. The leading read is ${input.primaryCatalyst.label.toLowerCase()}.`,
      `Evidence\n${this.evidenceLine(input)} Sources used: ${input.primaryCatalyst.sourceIds.join(", ")}.`,
      `Confidence\n${input.confidence.score}/100. ${input.confidence.rationale}`,
      `Watch Next\nMonitor whether the next source update confirms the catalyst, weakens the macro context, or shifts sector participation.`
    ].join("\n\n");
  }

  private dashboardBrief(input: ReturnType<typeof buildAnalystPromptInput>): string {
    return [
      `Summary\n${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}.`,
      `Catalyst\n${input.primaryCatalyst.label}: ${input.primaryCatalyst.explanation}`,
      `Confidence\n${input.confidence.score}/100. Sources: ${input.primaryCatalyst.sourceIds.join(", ")}.`
    ].join("\n\n");
  }

  private macroReaction(input: ReturnType<typeof buildAnalystPromptInput>): string {
    return [
      `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))} as macro inputs set the tone.`,
      `The move looks tied to ${input.primaryCatalyst.label.toLowerCase()}. ${this.evidenceLine(input)}`,
      `The important point is the channel: dollar momentum, yields, and rate expectations are doing more of the explanatory work than isolated positioning.`,
      `That keeps the next read dependent on the next macro print and how it reshapes yields and central-bank expectations.`
    ].join("\n\n");
  }

  private earningsReaction(input: ReturnType<typeof buildAnalystPromptInput>): string {
    return [
      `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))} as the market digests earnings context.`,
      `${this.evidenceLine(input)} The move appears more tied to the earnings and guidance read-through than to broad market direction alone.`,
      `The cleaner test is follow-through: whether sector participation and index context continue to support the reaction once the first earnings impulse fades.`
    ].join("\n\n");
  }

  private commodityReaction(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const snapshot = input.snapshot;
    if (snapshot.assetClass !== "commodity") {
      return this.publicTelegram(input);
    }

    return [
      `${input.subject} is ${promptFormatMove(snapshot.percentChange)}.`,
      `The move looks tied to ${input.primaryCatalyst.label.toLowerCase()}. ${this.cleanPublicEvidence(snapshot.dollarContext.value)}; ${this.cleanPublicEvidence(snapshot.yieldContext.value)}.`,
      `${this.cleanPublicEvidence(snapshot.inventoryContext.value)}. ${this.cleanPublicEvidence(snapshot.supplyDemandContext.value)}. That mix makes the move more evidence-led than a simple headline reaction.`,
      `The risk is that a reversal in the dollar, yields, or inventory assumptions could quickly change the tone.`
    ].join("\n\n");
  }

  private forexReaction(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const snapshot = input.snapshot;
    if (snapshot.assetClass !== "forex") {
      return this.publicTelegram(input);
    }

    return [
      `${input.subject} is ${promptFormatMove(snapshot.percentChange)}.`,
      `The move appears linked to rate-path and dollar context. ${this.cleanPublicEvidence(snapshot.dxyContext.value)}; ${this.cleanPublicEvidence(snapshot.yieldContext.value)}.`,
      `${this.cleanPublicEvidence(snapshot.centralBankContext.value)}. The market is still taking direction from relative-rate expectations rather than a single isolated headline.`,
      `The next macro print matters because it can either reinforce the current yield impulse or pull the pair back into a dollar-led move.`
    ].join("\n\n");
  }

  private equityMoverReaction(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const snapshot = input.snapshot;
    if (snapshot.assetClass !== "equity") {
      return this.publicTelegram(input);
    }

    return [
      `${input.subject} is ${promptFormatMove(snapshot.percentChange)}${snapshot.relativeVolume ? ` on ${snapshot.relativeVolume.toFixed(2)}x relative volume` : ""}.`,
      `The move appears linked to ${input.primaryCatalyst.label.toLowerCase()}. ${this.evidenceLine(input)}`,
      `${snapshot.sector} is ${formatMove(snapshot.sectorMove)} and the index context is ${formatMove(snapshot.indexMove)}, so the tape is being checked against both stock-specific and broader participation.`,
      `The next test is whether the catalyst keeps attracting confirmation from news, filings, earnings commentary, or sector follow-through.`
    ].join("\n\n");
  }

  private noConfirmedCatalyst(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const snapshot = input.snapshot;
    if (snapshot.assetClass === "equity") {
      const context =
        snapshot.sector && snapshot.sector !== "Unknown"
          ? `The wider market context matters here: ${snapshot.sector} is ${formatMove(snapshot.sectorMove)} and the relevant index is ${formatMove(snapshot.indexMove)}.`
          : `The wider market context matters here, with the relevant index ${formatMove(snapshot.indexMove)}.`;
      const volumeText =
        "volume" in snapshot && typeof snapshot.volume === "number" && snapshot.volume > 0
          ? ` on volume of ${snapshot.volume.toLocaleString()}`
          : "";
      return [
        `${input.subject} is ${promptFormatMove(snapshot.percentChange)}${volumeText}.`,
        `There is no confirmed company-specific catalyst in the current live sources, so the cleaner read is that the move is being shaped by broader tape pressure, positioning, or sector participation rather than a standalone ${input.subject} event. ${context}`,
        `The next check is whether the move is confirmed by Nasdaq direction, sector breadth, fresh company commentary, filings, earnings detail, or company-specific news.`
      ].join("\n\n");
    }

    if (snapshot.assetClass === "commodity") {
      const isGold = /^(GOLD|XAUUSD|XAU\/USD)$/i.test(input.subject);
      const moveLine =
        isGold && Math.abs(snapshot.percentChange) <= 0.1
          ? `${input.subject} is little changed, with price action looking muted rather than directionally weak.`
          : `${input.subject} is ${promptFormatMove(snapshot.percentChange)}.`;
      if (isGold) {
        return [
          moveLine,
          `There is no confirmed macro or safe-haven catalyst in the current live sources. The move looks more like consolidation while the market still needs clearer direction from DXY, Treasury yields, Fed expectations, inflation data, real yields if available, or safe-haven demand.`,
          `The next clean read comes from whether DXY and yields break directionally after incoming US macro data.`
        ].join("\n\n");
      }
      return [
        moveLine,
        `The commodity read should stay anchored to the dollar, yields, macro data, inventories, supply-demand evidence, and geopolitical risk. ${this.cleanPublicEvidence(snapshot.dollarContext.value)}; ${this.cleanPublicEvidence(snapshot.yieldContext.value)}.`,
        `The next clean read comes from an official inventory update, macro release, or credible supply-demand headline that changes the confidence level.`
      ].join("\n\n");
    }

    if (snapshot.assetClass === "forex") {
      return [
        `${input.subject} is ${promptFormatMove(snapshot.percentChange)}.`,
        `The FX read should stay anchored to dollar momentum, rates, yields, central-bank expectations, and scheduled macro data. ${this.cleanPublicEvidence(snapshot.dxyContext.value)}; ${this.cleanPublicEvidence(snapshot.yieldContext.value)}.`,
        `Without a confirmed macro release or central-bank headline, the pair should be described as moving on available price action rather than a clean fundamental catalyst.`,
        `The next clean read comes from a data print, policy comment, or clearer DXY/yield confirmation.`
      ].join("\n\n");
    }

    return [
      `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}.`,
      `The available source checks do not support a clean company-specific, macro-driven, earnings-related, or supply-demand explanation yet.`,
      `The cleaner read needs a filing, official release, credible news item, or clearer macro alignment before assigning a stronger explanation.`
    ].join("\n\n");
  }

  private evidenceLine(input: ReturnType<typeof buildAnalystPromptInput>): string {
    const evidence = this.cleanPublicEvidence(input.evidence[0]?.summary || input.primaryCatalyst.explanation);
    return evidence.endsWith(".") ? evidence : `${evidence}.`;
  }

  private cleanPublicEvidence(text: string): string {
    return text
      .replace(/\bmock consolidated\b/gi, "consolidated")
      .replace(/\bon the mock tape\b/gi, "")
      .replace(/\bin the mock (?:feed|model)\b/gi, "")
      .replace(/\bon the mock provider feed\b/gi, "")
      .replace(/\bmock provider feed\b/gi, "provider data")
      .replace(/\bmock feed\b/gi, "current live sources")
      .replace(/\bmock newswire\b/gi, "newswire")
      .replace(/\bmock\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+\./g, ".")
      .trim();
  }
}

export interface GeminiGenerateClient {
  models: {
    generateContent(input: {
      model: string;
      contents: string;
      config: {
        systemInstruction: string;
        responseMimeType: string;
        maxOutputTokens: number;
        temperature: number;
      };
    }): Promise<{ text?: string }>;
  };
}

export interface GeminiAnalystWriterOptions {
  apiKey?: string;
  model?: string;
  fallbackProvider?: string;
  fallback?: AnalystWriter;
  client?: GeminiGenerateClient;
  tracker?: AiUsageTracker;
  maxInputTokensPerRequest?: number;
  maxOutputTokensPerRequest?: number;
  maxGenerationsPerDay?: number;
}

interface GeneratedDraftResult {
  draft: AnalysisDraft;
  promptTokenEstimate: number;
  outputTokenEstimate: number;
  rawResponseUsable: boolean;
  jsonParseRecovered: boolean;
  responseMode: "text" | "json";
  qualityCheckResult: PublicOutputQualityResult;
}

export class GeminiAnalystWriter implements AnalystWriter {
  private readonly providerName = "gemini";
  private readonly model: string;
  private readonly fallbackProvider: string;
  private readonly fallback: AnalystWriter;
  private readonly tracker: AiUsageTracker;
  private readonly maxInputTokensPerRequest: number;
  private readonly maxOutputTokensPerRequest: number;
  private readonly maxGenerationsPerDay: number;
  private readonly client?: GeminiGenerateClient;

  constructor(options: GeminiAnalystWriterOptions = {}) {
    this.model = options.model ?? "gemini-2.5-flash";
    this.fallbackProvider = options.fallbackProvider ?? "template";
    this.fallback = options.fallback ?? new MockAnalystWriter();
    this.tracker = options.tracker ?? defaultAiUsageTracker;
    this.maxInputTokensPerRequest = options.maxInputTokensPerRequest ?? 6000;
    this.maxOutputTokensPerRequest = options.maxOutputTokensPerRequest ?? 700;
    this.maxGenerationsPerDay = options.maxGenerationsPerDay ?? 40;
    this.client = options.client ?? (options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey }) : undefined);
  }

  getStatus(): AiProviderStatus {
    const today = this.tracker.today(this.providerName);
    const recentUsage = this.tracker.list().slice(-10);
    const last = recentUsage.at(-1);
    const lastGeminiError = last && !last.success && last.callAttempted ? last : undefined;
    const todayAttemptedAiCalls = today.filter((record) => record.callAttempted).length;
    const todaySuccessfulAiCalls = today.filter((record) => record.success && !record.fallbackUsed).length;
    return {
      provider: "Gemini",
      model: this.model,
      fallbackProvider: this.fallbackProvider,
      configured: Boolean(this.client),
      todayAiCalls: todaySuccessfulAiCalls,
      todayAttemptedAiCalls,
      todaySuccessfulAiCalls,
      todayFallbackCount: today.filter((record) => record.fallbackUsed).length,
      maxGenerationsPerDay: this.maxGenerationsPerDay,
      recentUsage,
      lastProviderUsed: last?.providerName ?? this.providerName,
      lastProviderAttempted: last?.callAttempted ? last.providerName : "none",
      lastCallAttempted: last?.callAttempted ?? false,
      lastGeminiSuccess: last?.callAttempted ? last.success && !last.fallbackUsed : false,
      lastGeminiRawResponseUsable: last?.rawResponseUsable ?? false,
      lastGeminiJsonParseRecovered: last?.jsonParseRecovered ?? false,
      lastGeminiResponseMode: last?.responseMode ?? "text",
      lastQualityCheckResult: last?.qualityCheckResult,
      lastOriginalGeminiQualityPassed: last?.originalGeminiQualityPassed,
      lastQualityCheckPassed: last?.qualityCheckResult?.ok,
      lastQualityRewriteAttempted: last?.qualityRewriteAttempted ?? false,
      lastQualityRewritePassed: last?.qualityRewritePassed ?? false,
      lastFinalWriterUsed: last?.finalWriterUsed,
      lastGeminiOriginalOutputWordCount: last?.originalGeminiWordCount,
      lastGeminiRewriteOutputWordCount: last?.rewriteGeminiWordCount,
      lastFinalOutputWordCount: last?.finalOutputWordCount,
      lastQualityFailureReasons: last?.qualityFailureReasons,
      lastQualityTextEvaluatedSource: last?.qualityTextEvaluatedSource,
      lastFallbackReason: last?.fallbackUsed ? last.fallbackReason : undefined,
      lastGeminiError: lastGeminiError?.error,
      geminiConfigured: Boolean(this.client)
    };
  }

  async write(input: AnalystWritingInput): Promise<AnalysisDraft> {
    const promptTokenEstimate = estimateTokens(JSON.stringify(buildGeminiFacts(input)));
    let qualityRewriteAttempted = false;
    let qualityRewritePassed = false;
    let originalQuality: PublicOutputQualityResult | undefined;
    let rewriteQuality: PublicOutputQualityResult | undefined;
    let selectedQualitySource: "original" | "rewrite" | "final" = "original";
    this.logRoute({
      selectedProvider: this.providerName,
      geminiConfigured: Boolean(this.client),
      callAttempted: Boolean(this.client),
      success: false,
      fallbackUsed: false
    });
    if (!this.client) {
      return this.writeWithFallback(input, "missing Gemini API key", promptTokenEstimate);
    }

    if (this.getStatus().todayAttemptedAiCalls >= this.maxGenerationsPerDay) {
      return this.writeWithFallback(input, "daily Gemini generation limit reached", promptTokenEstimate);
    }

    try {
      const initial = await this.generateDraft(input);
      originalQuality = initial.qualityCheckResult;
      let selected = initial;

      if (!originalQuality.ok) {
        qualityRewriteAttempted = true;
        const rewrittenForQuality = await this.tryQualityRewrite(input, initial.draft, originalQuality);
        if (!rewrittenForQuality) {
          throw new Error(`Gemini output was too shallow: ${originalQuality.reasons.join(", ")}`);
        }
        rewriteQuality = rewrittenForQuality.qualityCheckResult;
        if (!rewriteQuality.ok) {
          throw new Error(`Gemini rewrite was too shallow: ${rewriteQuality.reasons.join(", ")}`);
        }
        qualityRewritePassed = true;
        selected = rewrittenForQuality;
        selectedQualitySource = "rewrite";
      }

      const compliance = new ComplianceEngine().review(selected.draft.body, {
        confidenceScore: input.confidence.score,
        sourceCount: selected.draft.sourcesUsed.length,
        publicOutput: isPublicMode(input.mode)
      });
      const style = validateAnalystStyle(selected.draft.body, {
        mode: input.mode,
        sourceIds: selected.draft.sourcesUsed,
        evidenceSummaries: selected.draft.catalyst.evidence.map((item) => item.summary)
      });

      const outputComplianceFlags = compliance.flags.filter((flag) => !["low_confidence", "weak_sourcing"].includes(flag.code));
      if (outputComplianceFlags.length > 0 || !style.ok) {
        const rewritten = await this.tryRewrite(input, selected.draft, { ...compliance, flags: outputComplianceFlags });
        if (rewritten) {
          const rewrittenCompliance = new ComplianceEngine().review(rewritten.draft.body, {
            confidenceScore: input.confidence.score,
            sourceCount: rewritten.draft.sourcesUsed.length,
            publicOutput: isPublicMode(input.mode)
          });
          const rewrittenStyle = validateAnalystStyle(rewritten.draft.body, {
            mode: input.mode,
            sourceIds: rewritten.draft.sourcesUsed,
            evidenceSummaries: rewritten.draft.catalyst.evidence.map((item) => item.summary)
          });
          const rewrittenOutputFlags = rewrittenCompliance.flags.filter((flag) => !["low_confidence", "weak_sourcing"].includes(flag.code));
          if (rewrittenOutputFlags.length === 0 && rewrittenStyle.ok && rewritten.qualityCheckResult.ok) {
            selected = rewritten;
            selectedQualitySource = "final";
          }
        }
      }

      this.recordGeminiSuccess(selected, {
        originalQuality: originalQuality ?? selected.qualityCheckResult,
        rewriteQuality,
        qualityRewriteAttempted,
        qualityRewritePassed,
        selectedQualitySource
      });
      return selected.draft;
    } catch (error) {
      return this.writeWithFallback(input, errorMessage(error), promptTokenEstimate, {
        originalQuality,
        rewriteQuality,
        attempted: qualityRewriteAttempted,
        passed: qualityRewritePassed
      });
    }
  }

  private async generateDraft(input: AnalystWritingInput, rewriteBody?: string, flags: string[] = []): Promise<GeneratedDraftResult> {
    const top = input.catalysts[0];
    if (!top) {
      throw new Error("Cannot write analysis without a catalyst candidate.");
    }

    const promptDefinition = getAnalystPromptDefinition(input.mode);
    const promptInput = buildAnalystPromptInput(input);
    const facts = buildGeminiFacts(input);
    const publicOutput = promptDefinition.publicOutput;
    const userPrompt = [
      "Write the final analyst commentary from this structured evidence only.",
      "Do not browse the web. Do not infer missing market data. Do not add facts that are not present here.",
      "Do not use markdown tables. Do not use buy, sell, entry, signal, hype, or 'as an AI' language.",
      publicOutput
        ? "Return plain text commentary only. Do not return JSON, markdown code fences, or labels. End with exactly: Market commentary only."
        : "Return the final note as plain text unless JSON is explicitly easier. If using JSON, keep it simple with a single text field.",
      publicOutput
        ? "Write a concise senior market analyst note in 3 short paragraphs plus the final line. Paragraph 1: state the asset move using live data. Paragraph 2: interpret the move using available market context. Paragraph 3: explain the next check/catalyst. Final line: Market commentary only. Length: 85-150 words. Do not return JSON unless explicitly requested. Do not return a one-line summary."
        : "Keep the internal note concise but analytical.",
      rewriteBody
        ? flags.includes("too_shallow")
          ? [
              "Rewrite this as a concise senior market analyst note in 3 short paragraphs.",
              "Paragraph 1: state the move using live price data.",
              "Paragraph 2: give interpretation using available context and explain whether the move has a confirmed catalyst or appears positioning/macro/sector-driven.",
              "Paragraph 3: state what matters next.",
              "End exactly with: Market commentary only.",
              "Do not use buy/sell/signal language. Do not use generic filler."
            ].join("\n")
          : "Rewrite the prior draft to remove compliance/style risk while preserving the evidence-led market read."
        : "Return a fresh draft.",
      JSON.stringify(
        {
          mode: input.mode,
          requiredOutput: publicOutput
            ? "Plain text final commentary only."
            : "Plain text note, or JSON object with text/commentary/body.",
          structuredFacts: facts,
          priorDraft: rewriteBody,
          riskFlagsToRemove: flags,
          expectedSources: promptInput.sources.map((source) => ({ id: source.id, title: source.title, type: source.type })),
          requiredPublicFooter: promptInput.publicFooter
        },
        null,
        2
      )
    ].join("\n\n");
    const promptTokenEstimate = estimateTokens(`${promptDefinition.systemPrompt}\n${userPrompt}`);
    if (promptTokenEstimate > this.maxInputTokensPerRequest) {
      throw new Error(
        `Gemini prompt estimate ${promptTokenEstimate} exceeds limit ${this.maxInputTokensPerRequest}.`
      );
    }

    const response = await this.client?.models.generateContent({
      model: this.model,
      contents: userPrompt,
      config: {
        systemInstruction: promptDefinition.systemPrompt,
        responseMimeType: "text/plain",
        maxOutputTokens: this.maxOutputTokensPerRequest,
        temperature: 0.5
      }
    });
    const raw = response?.text;
    if (!raw) {
      throw new Error("Gemini response was empty.");
    }

    const normalized = normalizeGeminiResponse(raw, {
      fallbackTitle: `${promptInput.subject}: ${top.label}`,
      fallbackSourcesUsed: top.sourceIds.length > 0 ? top.sourceIds : promptInput.sources.map((source) => source.id)
    });
    const parsed = promptDefinition.outputSchema.parse({
      title: normalized.title,
      body: normalized.body,
      sourcesUsed: normalized.sourcesUsed
    });
    const body = promptDefinition.publicOutput ? ensurePublicDisclaimer(parsed.body) : parsed.body;
    assertAnalystStyle(body, {
      mode: input.mode,
      sourceIds: parsed.sourcesUsed,
      evidenceSummaries: [...promptInput.evidence.map((item) => item.summary), ...promptInput.facts]
    });
    const qualityCheckResult = evaluatePublicOutputQuality(body, input.mode);

    return {
      draft: analysisDraftSchema.parse({
        mode: input.mode,
        title: parsed.title,
        body,
        confidence: input.confidence,
        catalyst: top,
        sourcesUsed: parsed.sourcesUsed
      }),
      promptTokenEstimate,
      outputTokenEstimate: estimateTokens(body),
      rawResponseUsable: normalized.rawResponseUsable,
      jsonParseRecovered: normalized.jsonParseRecovered,
      responseMode: normalized.responseMode,
      qualityCheckResult
    };
  }

  private async tryRewrite(
    input: AnalystWritingInput,
    draft: AnalysisDraft,
    compliance: ComplianceResult
  ): Promise<GeneratedDraftResult | null> {
    try {
      return await this.generateDraft(
        input,
        draft.body,
        compliance.flags.map((flag) => `${flag.code}: ${flag.phrase}`)
      );
    } catch {
      return null;
    }
  }

  private async tryQualityRewrite(
    input: AnalystWritingInput,
    draft: AnalysisDraft,
    quality: PublicOutputQualityResult
  ): Promise<GeneratedDraftResult | null> {
    try {
      return await this.generateDraft(input, draft.body, [
        "too_shallow",
        ...quality.reasons.map((reason) => `quality: ${reason}`)
      ]);
    } catch {
      return null;
    }
  }

  private recordGeminiSuccess(
    result: GeneratedDraftResult,
    quality: {
      originalQuality: PublicOutputQualityResult;
      rewriteQuality?: PublicOutputQualityResult;
      qualityRewriteAttempted: boolean;
      qualityRewritePassed: boolean;
      selectedQualitySource: "original" | "rewrite" | "final";
    }
  ): void {
    const failureReasons = quality.qualityRewriteAttempted ? quality.originalQuality.reasons : [];
    this.tracker.record({
      providerName: this.providerName,
      model: this.model,
      promptTokenEstimate: result.promptTokenEstimate,
      outputTokenEstimate: result.outputTokenEstimate,
      success: true,
      fallbackUsed: false,
      callAttempted: true,
      rawResponseUsable: result.rawResponseUsable,
      jsonParseRecovered: result.jsonParseRecovered,
      responseMode: result.responseMode,
      qualityCheckResult: result.qualityCheckResult,
      originalGeminiQualityPassed: quality.originalQuality.ok,
      qualityRewriteAttempted: quality.qualityRewriteAttempted,
      qualityRewritePassed: quality.qualityRewritePassed,
      finalWriterUsed: "gemini",
      originalGeminiWordCount: quality.originalQuality.wordCount,
      rewriteGeminiWordCount: quality.rewriteQuality?.wordCount,
      finalOutputWordCount: result.qualityCheckResult.wordCount,
      qualityFailureReasons: failureReasons,
      qualityTextEvaluatedSource: quality.selectedQualitySource
    });
    this.logRoute({
      selectedProvider: this.providerName,
      geminiConfigured: Boolean(this.client),
      callAttempted: true,
      success: true,
      fallbackUsed: false,
      jsonParseRecovered: result.jsonParseRecovered,
      responseMode: result.responseMode
    });
  }

  private async writeWithFallback(
    input: AnalystWritingInput,
    reason: string,
    promptTokenEstimate: number,
    qualityRewrite: {
      originalQuality?: PublicOutputQualityResult;
      rewriteQuality?: PublicOutputQualityResult;
      attempted: boolean;
      passed: boolean;
    } = {
      originalQuality: undefined,
      rewriteQuality: undefined,
      attempted: false,
      passed: false
    }
  ): Promise<AnalysisDraft> {
    const draft = await this.fallback.write(input);
    const fallbackQuality = evaluatePublicOutputQuality(draft.body, input.mode);
    const failureReasons =
      qualityRewrite.rewriteQuality?.reasons.length
        ? qualityRewrite.rewriteQuality.reasons
        : qualityRewrite.originalQuality?.reasons.length
          ? qualityRewrite.originalQuality.reasons
          : [sanitizeAiMessage(reason)];
    this.tracker.record({
      providerName: this.providerName,
      model: this.model,
      promptTokenEstimate,
      outputTokenEstimate: estimateTokens(draft.body),
      success: false,
      fallbackUsed: true,
      callAttempted: Boolean(this.client),
      rawResponseUsable: false,
      jsonParseRecovered: false,
      responseMode: "text",
      qualityCheckResult: fallbackQuality,
      originalGeminiQualityPassed: qualityRewrite.originalQuality?.ok,
      qualityRewriteAttempted: qualityRewrite.attempted,
      qualityRewritePassed: qualityRewrite.passed,
      finalWriterUsed: "template",
      originalGeminiWordCount: qualityRewrite.originalQuality?.wordCount,
      rewriteGeminiWordCount: qualityRewrite.rewriteQuality?.wordCount,
      finalOutputWordCount: fallbackQuality.wordCount,
      qualityFailureReasons: failureReasons,
      qualityTextEvaluatedSource: "final",
      error: sanitizeAiMessage(reason),
      fallbackReason: sanitizeAiMessage(reason)
    });
    this.logRoute({
      selectedProvider: this.providerName,
      geminiConfigured: Boolean(this.client),
      callAttempted: Boolean(this.client),
      success: false,
      fallbackUsed: true,
      fallbackReason: sanitizeAiMessage(reason)
    });
    return draft;
  }

  private logRoute(input: {
    selectedProvider: string;
    geminiConfigured: boolean;
    callAttempted: boolean;
    success: boolean;
    fallbackUsed: boolean;
    fallbackReason?: string;
    jsonParseRecovered?: boolean;
    responseMode?: "text" | "json";
  }): void {
    console.info("AI routing", {
      selectedAiProvider: input.selectedProvider,
      geminiConfigured: input.geminiConfigured,
      geminiCallAttempted: input.callAttempted,
      geminiSuccess: input.success,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
      jsonParseRecovered: input.jsonParseRecovered,
      responseMode: input.responseMode
    });
  }
}

export interface AnalysisResult {
  snapshot: MarketSnapshot;
  draft: AnalysisDraft;
  compliance: ComplianceResult;
}

export class AnalysisPipeline {
  constructor(
    private readonly snapshots: MarketSnapshotService,
    private readonly classifier = new CatalystClassifier(),
    private readonly confidenceEngine = new ConfidenceEngine(),
    private readonly writer: AnalystWriter = new MockAnalystWriter(),
    private readonly compliance = new ComplianceEngine()
  ) {}

  async analyzeEquity(symbol: string, mode: AnalysisMode = "dashboard_brief"): Promise<AnalysisResult> {
    const snapshot = await this.snapshots.getEquitySnapshot(symbol);
    return this.analyzeSnapshot(snapshot, mode);
  }

  async analyzeForex(pair: string, mode: AnalysisMode = "dashboard_brief"): Promise<AnalysisResult> {
    const snapshot = await this.snapshots.getForexSnapshot(pair);
    return this.analyzeSnapshot(snapshot, mode);
  }

  async analyzeCommodity(asset: string, mode: AnalysisMode = "dashboard_brief"): Promise<AnalysisResult> {
    const snapshot = await this.snapshots.getCommoditySnapshot(asset);
    return this.analyzeSnapshot(snapshot, mode);
  }

  getAiStatus(): AiProviderStatus {
    return this.writer.getStatus?.() ?? {
      provider: "unknown",
      model: "unknown",
      fallbackProvider: "template",
      configured: false,
      todayAiCalls: 0,
      todayAttemptedAiCalls: 0,
      todaySuccessfulAiCalls: 0,
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: [],
      lastProviderUsed: "unknown",
      lastProviderAttempted: "none",
      lastCallAttempted: false,
      lastGeminiRawResponseUsable: false,
      lastGeminiJsonParseRecovered: false,
      lastGeminiResponseMode: "text",
      lastQualityCheckResult: undefined,
      lastOriginalGeminiQualityPassed: undefined,
      lastQualityCheckPassed: undefined,
      lastQualityRewriteAttempted: false,
      lastQualityRewritePassed: false,
      lastFinalWriterUsed: undefined
    };
  }

  async analyzeSnapshot(snapshot: MarketSnapshot, mode: AnalysisMode): Promise<AnalysisResult> {
    const catalysts = this.classifier.classify(snapshot);
    const enrichedSnapshot = { ...snapshot, detectedCatalysts: catalysts } as MarketSnapshot;
    const confidence = this.confidenceEngine.score(enrichedSnapshot, catalysts);
    const draft = await this.writer.write({
      mode,
      snapshot: enrichedSnapshot,
      catalysts,
      confidence
    });
    const compliance = this.compliance.review(draft.body, {
      confidenceScore: confidence.score,
      sourceCount: draft.sourcesUsed.length,
      publicOutput: isPublicMode(mode)
    });

    const finalDraft = {
      ...draft,
      body: compliance.finalText || draft.body
    };

    assertAnalystStyle(finalDraft.body, {
      mode,
      sourceIds: finalDraft.sourcesUsed,
      evidenceSummaries: finalDraft.catalyst.evidence.map((item) => item.summary)
    });

    return {
      snapshot: enrichedSnapshot,
      draft: finalDraft,
      compliance
    };
  }
}

export function createAnalystWriterFromEnv(env: NodeJS.ProcessEnv = process.env): AnalystWriter {
  const provider = (env.AI_PROVIDER ?? "gemini").toLowerCase();
  console.info("AI provider router", {
    selectedAiProvider: provider,
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    fallbackProvider: env.AI_FALLBACK_PROVIDER ?? "template"
  });
  if (provider === "gemini") {
    return new GeminiAnalystWriter({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL_PRIMARY ?? "gemini-2.5-flash",
      fallbackProvider: env.AI_FALLBACK_PROVIDER ?? "template",
      maxInputTokensPerRequest: numberFromEnv(env.GEMINI_MAX_INPUT_TOKENS_PER_REQUEST, 6000),
      maxOutputTokensPerRequest: numberFromEnv(env.GEMINI_MAX_OUTPUT_TOKENS_PER_REQUEST, 700),
      maxGenerationsPerDay: numberFromEnv(env.MAX_AI_GENERATIONS_PER_DAY, 40)
    });
  }

  if (provider === "openai" && env.OPENAI_API_KEY) {
    return new OpenAIAnalystWriter(env.OPENAI_API_KEY, env.OPENAI_MODEL ?? "gpt-4.1-mini");
  }

  return new MockAnalystWriter();
}

export interface GeminiDebugProbeResult {
  configured: boolean;
  provider: "gemini";
  model: string;
  apiKeyPresent: boolean;
  callAttempted: boolean;
  success: boolean;
  responseText: string | null;
  errorName: string | null;
  errorMessage: string | null;
  fallbackWouldBeUsed: boolean;
}

export async function debugGeminiFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  client?: GeminiGenerateClient
): Promise<GeminiDebugProbeResult> {
  const model = env.GEMINI_MODEL_PRIMARY ?? "gemini-2.5-flash";
  const apiKey = env.GEMINI_API_KEY;
  const apiKeyPresent = Boolean(apiKey);
  const configured = apiKeyPresent;

  if (!configured) {
    return {
      configured,
      provider: "gemini",
      model,
      apiKeyPresent,
      callAttempted: false,
      success: false,
      responseText: null,
      errorName: "ProviderConfigError",
      errorMessage: "Gemini API key is not configured.",
      fallbackWouldBeUsed: true
    };
  }

  try {
    const gemini = client ?? new GoogleGenAI({ apiKey: apiKey as string });
    const response = await gemini.models.generateContent({
      model,
      contents: "Reply with exactly: ok",
      config: {
        systemInstruction: "Diagnostic probe. Reply exactly as requested.",
        responseMimeType: "text/plain",
        maxOutputTokens: 10,
        temperature: 0
      }
    });
    const responseText = response.text?.trim() ?? "";
    const success = responseText === "ok";
    return {
      configured,
      provider: "gemini",
      model,
      apiKeyPresent,
      callAttempted: true,
      success,
      responseText: success ? "ok" : sanitizeAiMessage(responseText),
      errorName: success ? null : "UnexpectedGeminiResponse",
      errorMessage: success ? null : "Gemini did not return the expected diagnostic response.",
      fallbackWouldBeUsed: !success
    };
  } catch (error) {
    return {
      configured,
      provider: "gemini",
      model,
      apiKeyPresent,
      callAttempted: true,
      success: false,
      responseText: null,
      errorName: error instanceof Error ? error.name || "GeminiError" : "GeminiError",
      errorMessage: errorMessage(error),
      fallbackWouldBeUsed: true
    };
  }
}

interface NormalizedGeminiResponse {
  title: string;
  body: string;
  sourcesUsed: string[];
  rawResponseUsable: boolean;
  jsonParseRecovered: boolean;
  responseMode: "text" | "json";
}

function normalizeGeminiResponse(
  raw: string,
  fallback: { fallbackTitle: string; fallbackSourcesUsed: string[] }
): NormalizedGeminiResponse {
  const cleaned = stripMarkdownCodeFence(raw).trim();
  if (!cleaned) {
    throw new Error("Gemini response was empty.");
  }

  if (appearsToBeJson(cleaned)) {
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      const fromJson = responseFromParsedJson(parsed, fallback);
      if (fromJson) {
        return {
          ...fromJson,
          rawResponseUsable: true,
          jsonParseRecovered: false,
          responseMode: "json"
        };
      }
    } catch {
      const recovered = recoverTextFromMalformedJson(cleaned);
      if (recovered) {
        return {
          title: fallback.fallbackTitle,
          body: recovered,
          sourcesUsed: fallbackSources(fallback.fallbackSourcesUsed),
          rawResponseUsable: true,
          jsonParseRecovered: true,
          responseMode: "text"
        };
      }
    }
  }

  return {
    title: fallback.fallbackTitle,
    body: cleaned,
    sourcesUsed: fallbackSources(fallback.fallbackSourcesUsed),
    rawResponseUsable: true,
    jsonParseRecovered: false,
    responseMode: "text"
  };
}

export function evaluatePublicOutputQuality(text: string, mode: AnalysisMode): PublicOutputQualityResult {
  if (!isPublicMode(mode) || mode === "x_short") {
    return {
      ok: true,
      wordCount: countWords(text),
      paragraphCount: paragraphCount(text),
      hasAssetMove: true,
      hasInterpretation: true,
      hasWhatMattersNext: true,
      endsWithFooter: true,
      hasBannedTradingAdvice: false,
      reasons: []
    };
  }

  const words = countWords(text);
  const paragraphs = paragraphCount(text);
  const hasAssetMove =
    /(?:\b[A-Z]{2,6}\b|\bNVDA\b|\bGold\b|\bGOLD\b|\bOil\b|\bWTI\b|\bEUR\/?USD\b|\bGBP\/?USD\b).*?\b(is|are|trades?|moves?|declined|rose|gained|fell|higher|lower|firmer|softer|flat|muted|little changed|consolidat)/i.test(text) ||
    /\b(price action|live pricing|live quote|percent move|%|volume)\b/i.test(text);
  const hasInterpretation =
    /\b(cleaner read|appears|looks|suggests|reflects|linked to|shaped by|pressure|participation|positioning|broader tape|wider market context matters|sector|index|macro|company-specific|not confirmed|confirmed catalyst|current live sources|market is pricing|consolidat|rate-driven|dollar|yield|safe-haven|standalone)\b/i.test(text);
  const hasWhatMattersNext =
    /\b(what matters next|the next (test|catalyst|check|clean read|useful evidence|read|focus)|the key (check|variable)|key check is|key variable is|the market (now needs|will be watching)|a stronger explanation would require|a clearer shift in|the move should be viewed against|the wider market context matters|next clean read comes from|next conditions?|watch|depends on|would need|will be whether|matters because|follow-through|earnings|filings|news|sector breadth|index direction|nasdaq direction|semiconductor breadth|dxy|yields|fed|inflation|inventories|opec|supply risk|incoming .*data|fresh .*commentary|company-specific news)\b/i.test(text);
  const endsWithFooter = /Market commentary only\.\s*$/i.test(text);
  const hasBannedTradingAdvice =
    /\b(buy|sell|long this|short this|entry|signal|pump|moon|guaranteed|risk-free|easy money|must buy|load up|this will definitely|financial advice)\b/i.test(text);
  const onlyRestatesPrice =
    hasAssetMove &&
    /\b(declined|rose|gained|fell|up|down|firmer|softer|little changed)\b/i.test(text) &&
    !hasInterpretation;
  const reasons: string[] = [];

  if (words < 55) {
    reasons.push("fewer than 55 words");
  }
  if (words > 180) {
    reasons.push("more than 180 words");
  }
  if (!hasAssetMove) {
    reasons.push("missing asset move or price action");
  }
  if (onlyRestatesPrice) {
    reasons.push("only restates price movement");
  }
  if (!hasInterpretation) {
    reasons.push("missing interpretation");
  }
  if (!hasWhatMattersNext) {
    reasons.push("missing what matters next");
  }
  if (!endsWithFooter) {
    reasons.push("missing required footer");
  }
  if (hasBannedTradingAdvice) {
    reasons.push("contains banned trading advice language");
  }

  return {
    ok: reasons.length === 0,
    wordCount: words,
    paragraphCount: paragraphs,
    hasAssetMove,
    hasInterpretation,
    hasWhatMattersNext,
    endsWithFooter,
    hasBannedTradingAdvice,
    reasons
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function paragraphCount(text: string): number {
  return text.trim().split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0).length;
}

function responseFromParsedJson(
  parsed: unknown,
  fallback: { fallbackTitle: string; fallbackSourcesUsed: string[] }
): Pick<NormalizedGeminiResponse, "title" | "body" | "sourcesUsed"> | null {
  if (typeof parsed === "string") {
    const body = parsed.trim();
    return body
      ? {
          title: fallback.fallbackTitle,
          body,
          sourcesUsed: fallbackSources(fallback.fallbackSourcesUsed)
        }
      : null;
  }

  if (Array.isArray(parsed)) {
    const body = parsed.filter((item): item is string => typeof item === "string").join("\n\n").trim();
    return body
      ? {
          title: fallback.fallbackTitle,
          body,
          sourcesUsed: fallbackSources(fallback.fallbackSourcesUsed)
        }
      : null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const body = firstString(record.text, record.commentary, record.body, record.content, record.response);
  if (!body) {
    return null;
  }

  const sources = Array.isArray(record.sourcesUsed)
    ? record.sourcesUsed.filter((source): source is string => typeof source === "string" && source.trim().length > 0)
    : fallback.fallbackSourcesUsed;

  return {
    title: firstString(record.title) ?? fallback.fallbackTitle,
    body,
    sourcesUsed: fallbackSources(sources)
  };
}

function recoverTextFromMalformedJson(text: string): string | null {
  const quotedField = /"(?:text|commentary|body|content|response)"\s*:\s*"([\s\S]*)/i.exec(text);
  if (quotedField?.[1]) {
    const recovered = trimPartialJsonString(quotedField[1]);
    if (recovered) {
      return recovered;
    }
  }

  const stripped = text
    .replace(/^\s*\{+\s*/g, "")
    .replace(/^\s*"(?:text|commentary|body|content|response)"\s*:\s*/i, "")
    .replace(/^\s*"/, "")
    .replace(/["'}\]]+\s*$/g, "")
    .trim();
  return /[.!?]\s*(Market commentary only\.)?$/i.test(stripped) && stripped.length >= 20 ? stripped : null;
}

function trimPartialJsonString(value: string): string | null {
  const closed = /^((?:\\.|[^"\\])*)"/.exec(value);
  const partial = (closed?.[1] ?? value)
    .replace(/["'}\]]+\s*$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();
  return partial.length >= 20 ? partial : null;
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function appearsToBeJson(text: string): boolean {
  const first = text.trim().charAt(0);
  return first === "{" || first === "[" || first === "\"";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function fallbackSources(sources: string[]): string[] {
  const cleaned = sources.filter((source) => source.trim().length > 0);
  return cleaned.length > 0 ? [...new Set(cleaned)] : ["src-market-data"];
}

function sameDirection(a: number, b: number): boolean {
  return (a >= 0 && b >= 0) || (a <= 0 && b <= 0);
}

function formatMove(percentChange: number): string {
  if (Math.abs(percentChange) <= 0.1) {
    return "little changed";
  }
  const direction = percentChange > 0 ? "up" : "down";
  return `${direction} ${Math.abs(percentChange).toFixed(2)}%`;
}

function describeSnapshotMove(snapshot: MarketSnapshot): string {
  if (Math.abs(snapshot.percentChange) <= 0.1) {
    return "little changed";
  }
  const direction = snapshot.percentChange > 0 ? "higher" : "lower";
  return `${direction} by ${Math.abs(snapshot.percentChange).toFixed(2)}%`;
}

function snapshotMove(snapshot: MarketSnapshot): number {
  return snapshot.percentChange;
}

function hasLiveSourceWarning(snapshot: MarketSnapshot): boolean {
  return snapshot.sources.some((source) => source.id === "src-live-source-warning");
}

function buildGeminiFacts(input: AnalystWritingInput): Record<string, unknown> {
  const snapshot = input.snapshot;
  const base = {
    asset: snapshot.assetClass === "equity" ? snapshot.symbol : snapshot.assetClass === "forex" ? snapshot.pair : snapshot.asset,
    assetType: snapshot.assetClass,
    normalizedSymbol: snapshot.normalizedSymbol,
    currentPrice: "price" in snapshot ? snapshot.price ?? null : null,
    priceMove: describeSnapshotMove(snapshot),
    percentChange: snapshot.percentChange,
    absoluteChange:
      "price" in snapshot && typeof snapshot.price === "number" && typeof snapshot.previousClose === "number"
        ? snapshot.price - snapshot.previousClose
        : null,
    previousClose: snapshot.previousClose ?? null,
    open: snapshot.open ?? null,
    high: snapshot.high ?? null,
    low: snapshot.low ?? null,
    timestamp: snapshot.sourceTime ?? snapshot.generatedAt,
    quoteProvider: snapshot.sourceName ?? null,
    providerSymbol: snapshot.providerSymbol ?? null,
    missingDataWarnings: missingDataWarnings(snapshot),
    sources: snapshot.sources.map((source) => ({
      id: source.id,
      provider: source.provider,
      type: source.type,
      title: source.title,
      publishedAt: source.publishedAt
    })),
    catalystClassification: input.catalysts[0]?.classification ?? "no_confirmed_catalyst",
    catalystLabel: input.catalysts[0]?.label,
    catalystEvidence: input.catalysts[0]?.evidence.map((evidence) => ({
      kind: evidence.kind,
      summary: evidence.summary,
      sourceId: evidence.sourceId
    })),
    confidenceScore: input.confidence.score,
    confidenceRationale: input.confidence.rationale,
    complianceRiskLevel: complianceRiskLevel(input)
  };

  if (snapshot.assetClass === "equity") {
    return {
      ...base,
      companyName: snapshot.name ?? null,
      exchange: snapshot.exchange ?? null,
      currency: snapshot.currency ?? null,
      volume: snapshot.volume,
      averageVolume: null,
      relativeVolume: snapshot.relativeVolume,
      sectorContext: {
        sector: snapshot.sector,
        sectorMove: snapshot.sectorMove,
        indexMove: snapshot.indexMove
      },
      indexContext: {
        indexMove: snapshot.indexMove
      },
      newsAvailable: snapshot.latestNews.length > 0,
      newsCount: snapshot.latestNews.length,
      newsSummaries: snapshot.latestNews.map((item) => ({
        headline: item.headline,
        summary: item.summary,
        sourceId: item.sourceId,
        publishedAt: item.publishedAt
      })),
      filingsAvailable: snapshot.latestFilings.length > 0,
      filingsCount: snapshot.latestFilings.length,
      filings: snapshot.latestFilings.map((filing) => ({
        filingType: filing.filingType,
        title: filing.title,
        sourceId: filing.sourceId,
        filedAt: filing.filedAt
      })),
      earningsContext: snapshot.earningsContext
    };
  }

  if (snapshot.assetClass === "forex") {
    return {
      ...base,
      macroAvailable: hasMacroContext(snapshot),
      macroNotes: [
        snapshot.dxyContext.value,
        snapshot.yieldContext.value,
        snapshot.centralBankContext.value,
        ...snapshot.macroEvents.map((event) => `${event.name}: consensus ${event.consensus ?? "n/a"}, prior ${event.prior ?? "n/a"}`)
      ],
      forexMacroContext: {
        dxyContext: snapshot.dxyContext,
        yieldContext: snapshot.yieldContext,
        centralBankContext: snapshot.centralBankContext,
        macroEvents: snapshot.macroEvents
      }
    };
  }

  return {
    ...base,
    macroAvailable: hasMacroContext(snapshot),
    macroNotes: [
      snapshot.dollarContext.value,
      snapshot.yieldContext.value,
      snapshot.inventoryContext.value,
      snapshot.supplyDemandContext.value,
      snapshot.geopoliticalContext.value
    ],
    commodityContext: {
      dollarContext: snapshot.dollarContext,
      yieldContext: snapshot.yieldContext,
      inventoryContext: snapshot.inventoryContext,
      supplyDemandContext: snapshot.supplyDemandContext,
      geopoliticalContext: snapshot.geopoliticalContext
    }
  };
}

function complianceRiskLevel(input: AnalystWritingInput): "low" | "medium" | "high" {
  if (input.confidence.score < 50 || input.catalysts[0]?.classification === "no_confirmed_catalyst") {
    return "high";
  }
  if (input.confidence.score < 70 || hasLiveSourceWarning(input.snapshot)) {
    return "medium";
  }
  return "low";
}

function missingDataWarnings(snapshot: MarketSnapshot): string[] {
  const warnings: string[] = [];
  if (snapshot.assetClass === "equity") {
    if (snapshot.latestNews.length === 0) {
      warnings.push("Company news unavailable or no recent headlines returned.");
    }
    if (snapshot.latestFilings.length === 0) {
      warnings.push("Recent SEC filing context unavailable or no recent filings returned.");
    }
    if (snapshot.sector === "Unknown") {
      warnings.push("Sector context unavailable.");
    }
    if (snapshot.indexMove === 0) {
      warnings.push("Index context unavailable or flat.");
    }
  }

  if (snapshot.assetClass === "forex") {
    if (!hasMacroContext(snapshot)) {
      warnings.push("Macro context unavailable from optional sources.");
    }
    if (snapshot.macroEvents.length === 0) {
      warnings.push("Macro calendar events unavailable or empty.");
    }
  }

  if (snapshot.assetClass === "commodity") {
    if (!hasMacroContext(snapshot)) {
      warnings.push("Commodity macro context unavailable from optional sources.");
    }
  }

  return warnings;
}

function hasMacroContext(snapshot: MarketSnapshot): boolean {
  if (snapshot.assetClass === "equity") {
    return false;
  }

  if (snapshot.assetClass === "forex") {
    return [snapshot.dxyContext, snapshot.yieldContext, snapshot.centralBankContext].some((context) => context.sourceId);
  }

  return [
    snapshot.dollarContext,
    snapshot.yieldContext,
    snapshot.inventoryContext,
    snapshot.supplyDemandContext,
    snapshot.geopoliticalContext
  ].some((context) => context.sourceId);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "Gemini response could not be parsed.";
  }
  if (error instanceof Error) {
    const status = "status" in error ? ` status=${String((error as { status?: unknown }).status)}` : "";
    return sanitizeAiMessage(`${error.message}${status}`);
  }
  return "Gemini generation failed.";
}

function sanitizeAiMessage(message: string): string {
  return message
    .replace(/(key|api_key|apikey|token)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-google-api-key]")
    .slice(0, 500);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
