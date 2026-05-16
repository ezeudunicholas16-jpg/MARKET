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

    return this.candidate({
      classification: "no_confirmed_catalyst",
      label,
      explanation: "There is no clean confirmed catalyst from available live sources at the time of writing.",
      confidenceScore: 35,
      evidence: [
        {
          sourceId: hasLiveSourceWarning(snapshot) ? "src-live-source-warning" : "src-market-mock",
          kind: "market_data",
          summary: "There is no clean confirmed catalyst from available live sources at the time of writing.",
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
  timestamp: string;
  error?: string;
}

export interface AiProviderStatus {
  provider: string;
  model: string;
  fallbackProvider: string;
  configured: boolean;
  todayAiCalls: number;
  todayFallbackCount: number;
  maxGenerationsPerDay: number;
  recentUsage: AiUsageRecord[];
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
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: []
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
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: []
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
      `The useful observation is that the move is not being framed off price alone. The read combines catalyst evidence with broader market context before assigning confidence at ${input.confidence.score}/100.`,
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
    return [
      `${input.subject} is ${promptFormatMove(promptSnapshotMove(input.snapshot))}. There is no clean confirmed catalyst from available live sources at the time of writing.`,
      `Price action is available, yet the source set does not provide enough support to frame the move as company-specific, macro-driven, earnings-related, or supply-demand driven.`,
      `The right stance is caution: wait for a filing, official release, credible news item, or clearer macro alignment before assigning a stronger explanation.`
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
      .replace(/\bmock feed\b/gi, "source set")
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
        responseJsonSchema: unknown;
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
    return {
      provider: "Gemini",
      model: this.model,
      fallbackProvider: this.fallbackProvider,
      configured: Boolean(this.client),
      todayAiCalls: today.filter((record) => !record.fallbackUsed).length,
      todayFallbackCount: today.filter((record) => record.fallbackUsed).length,
      maxGenerationsPerDay: this.maxGenerationsPerDay,
      recentUsage: this.tracker.list().slice(-10)
    };
  }

  async write(input: AnalystWritingInput): Promise<AnalysisDraft> {
    const promptTokenEstimate = estimateTokens(JSON.stringify(buildGeminiFacts(input)));
    if (!this.client) {
      return this.writeWithFallback(input, "missing Gemini API key", promptTokenEstimate);
    }

    if (this.getStatus().todayAiCalls >= this.maxGenerationsPerDay) {
      return this.writeWithFallback(input, "daily Gemini generation limit reached", promptTokenEstimate);
    }

    try {
      const initial = await this.generateDraft(input);
      const compliance = new ComplianceEngine().review(initial.body, {
        confidenceScore: input.confidence.score,
        sourceCount: initial.sourcesUsed.length,
        publicOutput: isPublicMode(input.mode)
      });
      const style = validateAnalystStyle(initial.body, {
        mode: input.mode,
        sourceIds: initial.sourcesUsed,
        evidenceSummaries: initial.catalyst.evidence.map((item) => item.summary)
      });

      const outputComplianceFlags = compliance.flags.filter((flag) => !["low_confidence", "weak_sourcing"].includes(flag.code));
      if (outputComplianceFlags.length === 0 && style.ok) {
        return initial;
      }

      const rewritten = await this.tryRewrite(input, initial, { ...compliance, flags: outputComplianceFlags });
      if (!rewritten) {
        return initial;
      }

      const rewrittenCompliance = new ComplianceEngine().review(rewritten.body, {
        confidenceScore: input.confidence.score,
        sourceCount: rewritten.sourcesUsed.length,
        publicOutput: isPublicMode(input.mode)
      });
      const rewrittenStyle = validateAnalystStyle(rewritten.body, {
        mode: input.mode,
        sourceIds: rewritten.sourcesUsed,
        evidenceSummaries: rewritten.catalyst.evidence.map((item) => item.summary)
      });

      return rewrittenCompliance.flags.length === 0 && rewrittenStyle.ok ? rewritten : initial;
    } catch (error) {
      return this.writeWithFallback(input, errorMessage(error), promptTokenEstimate);
    }
  }

  private async generateDraft(input: AnalystWritingInput, rewriteBody?: string, flags: string[] = []): Promise<AnalysisDraft> {
    const top = input.catalysts[0];
    if (!top) {
      throw new Error("Cannot write analysis without a catalyst candidate.");
    }

    const promptDefinition = getAnalystPromptDefinition(input.mode);
    const promptInput = buildAnalystPromptInput(input);
    const facts = buildGeminiFacts(input);
    const userPrompt = [
      "Write the final analyst commentary from this structured evidence only.",
      "Do not browse the web. Do not infer missing market data. Do not add facts that are not present here.",
      rewriteBody
        ? "Rewrite the prior draft to remove compliance/style risk while preserving the evidence-led market read."
        : "Return a fresh draft.",
      JSON.stringify(
        {
          mode: input.mode,
          requiredOutput: "JSON only with title, body, sourcesUsed.",
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
        responseMimeType: "application/json",
        responseJsonSchema: promptDefinition.outputJsonSchema,
        maxOutputTokens: this.maxOutputTokensPerRequest,
        temperature: 0.35
      }
    });
    const raw = response?.text;
    if (!raw) {
      throw new Error("Gemini response did not include text.");
    }

    const parsed = promptDefinition.outputSchema.parse(JSON.parse(extractJson(raw)));
    const body = promptDefinition.publicOutput ? ensurePublicDisclaimer(parsed.body) : parsed.body;
    assertAnalystStyle(body, {
      mode: input.mode,
      sourceIds: parsed.sourcesUsed,
      evidenceSummaries: [...promptInput.evidence.map((item) => item.summary), ...promptInput.facts]
    });
    this.tracker.record({
      providerName: this.providerName,
      model: this.model,
      promptTokenEstimate,
      outputTokenEstimate: estimateTokens(body),
      success: true,
      fallbackUsed: false
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

  private async tryRewrite(
    input: AnalystWritingInput,
    draft: AnalysisDraft,
    compliance: ComplianceResult
  ): Promise<AnalysisDraft | null> {
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

  private async writeWithFallback(
    input: AnalystWritingInput,
    reason: string,
    promptTokenEstimate: number
  ): Promise<AnalysisDraft> {
    const draft = await this.fallback.write(input);
    this.tracker.record({
      providerName: this.providerName,
      model: this.model,
      promptTokenEstimate,
      outputTokenEstimate: estimateTokens(draft.body),
      success: false,
      fallbackUsed: true,
      error: reason
    });
    return draft;
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
      todayFallbackCount: 0,
      maxGenerationsPerDay: Number.POSITIVE_INFINITY,
      recentUsage: []
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

function sameDirection(a: number, b: number): boolean {
  return (a >= 0 && b >= 0) || (a <= 0 && b <= 0);
}

function formatMove(percentChange: number): string {
  const direction = percentChange >= 0 ? "up" : "down";
  return `${direction} ${Math.abs(percentChange).toFixed(2)}%`;
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
    priceMove: formatMove(snapshot.percentChange),
    percentChange: snapshot.percentChange,
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
      volume: snapshot.volume,
      relativeVolume: snapshot.relativeVolume,
      sectorContext: {
        sector: snapshot.sector,
        sectorMove: snapshot.sectorMove,
        indexMove: snapshot.indexMove
      },
      newsSummaries: snapshot.latestNews.map((item) => ({
        headline: item.headline,
        summary: item.summary,
        sourceId: item.sourceId,
        publishedAt: item.publishedAt
      })),
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const status = "status" in error ? ` status=${String((error as { status?: unknown }).status)}` : "";
    return `${error.message}${status}`;
  }
  return "Gemini generation failed.";
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
