import { z } from "zod";
import {
  AnalysisMode,
  analysisModeSchema,
  catalystCandidateSchema,
  confidenceResultSchema,
  marketSnapshotSchema,
  sourceEvidenceSchema,
  sourceSchema
} from "@market-desk/shared";

export const analystPromptEvidenceSchema = sourceEvidenceSchema.extend({
  sourceTitle: z.string().optional(),
  sourceType: z.string().optional()
});
export type AnalystPromptEvidence = z.infer<typeof analystPromptEvidenceSchema>;

export const analystPromptInputSchema = z.object({
  mode: analysisModeSchema,
  subject: z.string(),
  assetClass: z.enum(["equity", "forex", "commodity"]),
  snapshot: marketSnapshotSchema,
  primaryCatalyst: catalystCandidateSchema,
  catalysts: z.array(catalystCandidateSchema),
  confidence: confidenceResultSchema,
  evidence: z.array(analystPromptEvidenceSchema),
  sources: z.array(sourceSchema),
  facts: z.array(z.string()),
  publicFooter: z.literal("Market commentary only.").optional(),
  styleInstruction: z.string()
});
export type AnalystPromptInput = z.infer<typeof analystPromptInputSchema>;

export const analystPromptOutputSchema = z.object({
  title: z.string().min(3).max(120),
  body: z.string().min(20).max(2200),
  sourcesUsed: z.array(z.string()).min(1)
});
export type AnalystPromptOutput = z.infer<typeof analystPromptOutputSchema>;

export const xShortOutputSchema = analystPromptOutputSchema.extend({
  body: z.string().min(20).max(280)
});

export interface JsonSchemaObject {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
}

export const baseOutputJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "sourcesUsed"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: 120 },
    body: { type: "string", minLength: 20, maxLength: 2200 },
    sourcesUsed: {
      type: "array",
      minItems: 1,
      items: { type: "string" }
    }
  }
};

export const xShortOutputJsonSchema: JsonSchemaObject = {
  ...baseOutputJsonSchema,
  properties: {
    ...baseOutputJsonSchema.properties,
    body: { type: "string", minLength: 20, maxLength: 280 }
  }
};

export const promptModeSchema = analysisModeSchema;
export type PromptMode = AnalysisMode;
