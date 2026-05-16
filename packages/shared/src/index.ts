import { z } from "zod";

export const assetClassSchema = z.enum(["equity", "forex", "commodity", "index"]);
export type AssetClass = z.infer<typeof assetClassSchema>;

export const analysisModeSchema = z.enum([
  "private_research",
  "public_telegram",
  "x_short",
  "dashboard_brief",
  "earnings_reaction",
  "macro_reaction",
  "no_confirmed_catalyst",
  "commodity_reaction",
  "forex_reaction",
  "equity_mover_reaction"
]);
export type AnalysisMode = z.infer<typeof analysisModeSchema>;

export const catalystClassificationSchema = z.enum([
  "company_specific",
  "sector_wide",
  "macro_driven",
  "earnings_related",
  "analyst_action",
  "mna_or_partnership",
  "regulatory_or_legal",
  "commodity_supply_demand",
  "fx_rate_expectation",
  "no_confirmed_catalyst",
  "mixed"
]);
export type CatalystClassification = z.infer<typeof catalystClassificationSchema>;

export const sourceSchema = z.object({
  id: z.string(),
  provider: z.string(),
  type: z.enum(["news", "filing", "earnings", "macro", "market_data", "official", "internal"]),
  title: z.string(),
  url: z.string().url().optional(),
  publishedAt: z.string().datetime().optional(),
  retrievedAt: z.string().datetime().optional(),
  credibilityScore: z.number().min(0).max(100).optional()
});
export type SourceRecord = z.infer<typeof sourceSchema>;

export const sourceEvidenceSchema = z.object({
  sourceId: z.string(),
  kind: z.enum(["headline", "filing", "macro_release", "market_data", "provider_note", "earnings"]),
  summary: z.string(),
  weight: z.number().min(0).max(1)
});
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;

export const newsItemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  headline: z.string(),
  summary: z.string().optional(),
  url: z.string().url().optional(),
  sourceName: z.string(),
  publishedAt: z.string().datetime(),
  credibilityScore: z.number().min(0).max(100).optional()
});
export type NewsItem = z.infer<typeof newsItemSchema>;

export const filingSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  symbol: z.string(),
  filingType: z.string(),
  title: z.string(),
  filedAt: z.string().datetime(),
  url: z.string().url().optional()
});
export type FilingRecord = z.infer<typeof filingSchema>;

export const earningsContextSchema = z.object({
  lastReportedAt: z.string().datetime().optional(),
  nextReportAt: z.string().datetime().optional(),
  epsSurprisePercent: z.number().optional(),
  revenueSurprisePercent: z.number().optional(),
  guidance: z.string().optional(),
  sourceId: z.string().optional()
});
export type EarningsContext = z.infer<typeof earningsContextSchema>;

export const macroContextSchema = z.object({
  label: z.string(),
  value: z.string(),
  bias: z.enum(["supportive", "pressuring", "neutral", "mixed"]),
  sourceId: z.string().optional(),
  asOf: z.string().datetime()
});
export type MacroContext = z.infer<typeof macroContextSchema>;

export const macroEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  importance: z.enum(["low", "medium", "high"]),
  scheduledFor: z.string().datetime(),
  actual: z.string().optional(),
  consensus: z.string().optional(),
  prior: z.string().optional(),
  sourceId: z.string()
});
export type MacroEvent = z.infer<typeof macroEventSchema>;

export const quoteSchema = z.object({
  symbol: z.string(),
  assetClass: assetClassSchema,
  price: z.number(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  previousClose: z.number().optional(),
  percentChange: z.number(),
  volume: z.number().optional(),
  relativeVolume: z.number().optional(),
  asOf: z.string().datetime(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  providerSymbol: z.string().optional(),
  providerStatus: z.record(z.unknown()).optional(),
  isStale: z.boolean().optional()
});
export type Quote = z.infer<typeof quoteSchema>;

export const catalystCandidateSchema = z.object({
  classification: catalystClassificationSchema,
  label: z.string(),
  evidence: z.array(sourceEvidenceSchema),
  confidenceScore: z.number().min(0).max(100),
  sourceIds: z.array(z.string()),
  explanation: z.string()
});
export type CatalystCandidate = z.infer<typeof catalystCandidateSchema>;

const snapshotBaseSchema = z.object({
  generatedAt: z.string().datetime(),
  sources: z.array(sourceSchema),
  detectedCatalysts: z.array(catalystCandidateSchema)
});

export const equitySnapshotSchema = snapshotBaseSchema.extend({
  assetClass: z.literal("equity"),
  symbol: z.string(),
  normalizedSymbol: z.string().optional(),
  name: z.string().optional(),
  exchange: z.string().optional(),
  currency: z.string().optional(),
  price: z.number(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  previousClose: z.number().optional(),
  percentChange: z.number(),
  volume: z.number(),
  relativeVolume: z.number().nullable(),
  sourceName: z.string().optional(),
  sourceTime: z.string().datetime().optional(),
  providerSymbol: z.string().optional(),
  providerStatus: z.record(z.unknown()).optional(),
  sector: z.string(),
  sectorMove: z.number(),
  indexMove: z.number(),
  latestNews: z.array(newsItemSchema),
  latestFilings: z.array(filingSchema),
  earningsContext: earningsContextSchema.nullable()
});
export type EquitySnapshot = z.infer<typeof equitySnapshotSchema>;

export const forexSnapshotSchema = snapshotBaseSchema.extend({
  assetClass: z.literal("forex"),
  pair: z.string(),
  normalizedSymbol: z.string().optional(),
  price: z.number().optional(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  previousClose: z.number().optional(),
  percentChange: z.number(),
  sourceName: z.string().optional(),
  sourceTime: z.string().datetime().optional(),
  providerSymbol: z.string().optional(),
  providerStatus: z.record(z.unknown()).optional(),
  dxyContext: macroContextSchema,
  yieldContext: macroContextSchema,
  centralBankContext: macroContextSchema,
  macroEvents: z.array(macroEventSchema)
});
export type ForexSnapshot = z.infer<typeof forexSnapshotSchema>;

export const commoditySnapshotSchema = snapshotBaseSchema.extend({
  assetClass: z.literal("commodity"),
  asset: z.string(),
  normalizedSymbol: z.string().optional(),
  price: z.number().optional(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  previousClose: z.number().optional(),
  percentChange: z.number(),
  sourceName: z.string().optional(),
  sourceTime: z.string().datetime().optional(),
  providerSymbol: z.string().optional(),
  providerStatus: z.record(z.unknown()).optional(),
  dollarContext: macroContextSchema,
  yieldContext: macroContextSchema,
  inventoryContext: macroContextSchema,
  supplyDemandContext: macroContextSchema,
  geopoliticalContext: macroContextSchema
});
export type CommoditySnapshot = z.infer<typeof commoditySnapshotSchema>;

export const marketSnapshotSchema = z.discriminatedUnion("assetClass", [
  equitySnapshotSchema,
  forexSnapshotSchema,
  commoditySnapshotSchema
]);
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

export const confidenceResultSchema = z.object({
  score: z.number().min(0).max(100),
  band: z.enum(["confirmed", "strong", "interpretive", "weak"]),
  rationale: z.string(),
  requiresReview: z.boolean()
});
export type ConfidenceResult = z.infer<typeof confidenceResultSchema>;

export const analysisDraftSchema = z.object({
  mode: analysisModeSchema,
  title: z.string(),
  body: z.string(),
  confidence: confidenceResultSchema,
  catalyst: catalystCandidateSchema,
  sourcesUsed: z.array(z.string())
});
export type AnalysisDraft = z.infer<typeof analysisDraftSchema>;

export function normalizeSymbol(input: string): string {
  return input.trim().replace("/", "").replace("-", "").toUpperCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}
