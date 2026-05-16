import { z } from "zod";
import { AnalysisMode } from "@market-desk/shared";
import {
  AnalystPromptInput,
  AnalystPromptOutput,
  JsonSchemaObject,
  analystPromptInputSchema,
  analystPromptOutputSchema,
  baseOutputJsonSchema,
  xShortOutputJsonSchema,
  xShortOutputSchema
} from "./schemas";
import { isPublicMode } from "./style-validator";

export interface AnalystPromptDefinition {
  mode: AnalysisMode;
  publicOutput: boolean;
  systemPrompt: string;
  userPromptTemplate(input: AnalystPromptInput): string;
  inputSchema: z.ZodType<AnalystPromptInput>;
  outputSchema: z.ZodType<AnalystPromptOutput>;
  outputJsonSchema: JsonSchemaObject;
}

const publicStyleRules = [
  "Write like a senior market analyst after reviewing structured price action, macro context, news, filings, and sector data.",
  "Be concise, precise, and evidence-led.",
  "Public commentary should normally be three short paragraphs: move, interpretation, and what matters next.",
  "Write a concise senior market analyst note in 3 short paragraphs plus the final line. Paragraph 1: state the asset move using live data. Paragraph 2: interpret the move using available market context. Paragraph 3: explain the next check or catalyst.",
  "Target 85-150 words for public commentary, with a hard minimum of 55 words and a hard maximum of 180 words.",
  "Do not return a one-line summary.",
  "Do not stop at a quote recap. Always explain the likely market read using available evidence and clearly say when a company-specific or macro catalyst is not confirmed.",
  "Avoid stiff phrases such as 'the index read is', 'the source set', 'available live sources at the time of writing', 'the desk would need', and 'standalone confirmed story'.",
  "Prefer natural desk language: 'The cleaner read is', 'The wider market context matters here', 'The next check is', and 'A stronger explanation would require'.",
  "Do not sound like a chatbot. Do not use generic filler or basic finance lessons.",
  "No trade recommendations, no buy/sell language, no entries, no signals, no price targets, no hype.",
  "Do not invent facts beyond the structured input.",
  "Never mention source IDs, JSON, schemas, mock data, provider mode, or internal pipeline mechanics.",
  "Avoid headings in public commentary unless the mode explicitly asks for research format.",
  "Use cautious language when confidence is weak.",
  "Public output must end with exactly: Market commentary only."
].join(" ");

const researchStyleRules = [
  "Write like a senior market analyst preparing a concise internal research note.",
  "Use short research headings only in private_research or dashboard_brief modes.",
  "Separate verified facts from interpretation.",
  "No trade recommendations, entries, signals, hype, or unsupported certainty.",
  "Do not invent facts beyond the structured input."
].join(" ");

const modeGuidance: Record<AnalysisMode, string> = {
  public_telegram:
    "Produce 3 short paragraphs. Paragraph 1 states the asset move with price, percent move, and volume if available. Paragraph 2 gives interpretation, including whether the move looks like positioning, index/sector pressure, broader tape weakness, or a confirmed catalyst. Paragraph 3 explains the next check or catalyst. No heading.",
  x_short:
    "Produce one compact post under 280 characters. Include the main move, catalyst, evidence anchor, and required footer. No heading.",
  private_research:
    "Produce an internal note with headings: Desk View, Evidence, Confidence, Watch Next. Keep it concise.",
  dashboard_brief:
    "Produce a dashboard note with headings: Summary, Catalyst, Confidence. Keep it concise for admin review.",
  macro_reaction:
    "Focus on macro channels: dollar, yields, rate expectations, inflation or central-bank implications. Avoid generic risk-on/risk-off claims unless supported.",
  earnings_reaction:
    "Focus on earnings facts, guidance, surprise metrics, margins, revenue, and whether price action is aligned with sector/index context.",
  no_confirmed_catalyst:
    "Make the absence of confirmation explicit without sounding robotic. Explain what is known from price action, what is not confirmed in news/filings/macro evidence, and what evidence would change the read. Use cautious language.",
  commodity_reaction:
    "Focus on dollar/yield context, inventories, supply-demand, geopolitical inputs, and whether the move is macro-driven or commodity-specific. For gold, discuss DXY, yields, Fed expectations, inflation data, safe-haven demand, and consolidation when the move is small. Do not mention inventories or supply-demand for gold unless those fields contain actual evidence.",
  forex_reaction:
    "Focus on DXY, yield differentials, central-bank expectations, macro calendar, and what would challenge the currency move.",
  equity_mover_reaction:
    "Focus on price action, relative volume, company news/filings, earnings context, sector move, and index context."
};

const systemPromptByMode: Record<AnalysisMode, string> = {
  public_telegram: `${publicStyleRules} ${modeGuidance.public_telegram}`,
  x_short: `${publicStyleRules} ${modeGuidance.x_short}`,
  private_research: `${researchStyleRules} ${modeGuidance.private_research}`,
  dashboard_brief: `${researchStyleRules} ${modeGuidance.dashboard_brief}`,
  macro_reaction: `${publicStyleRules} ${modeGuidance.macro_reaction}`,
  earnings_reaction: `${publicStyleRules} ${modeGuidance.earnings_reaction}`,
  no_confirmed_catalyst: `${publicStyleRules} ${modeGuidance.no_confirmed_catalyst}`,
  commodity_reaction: `${publicStyleRules} ${modeGuidance.commodity_reaction}`,
  forex_reaction: `${publicStyleRules} ${modeGuidance.forex_reaction}`,
  equity_mover_reaction: `${publicStyleRules} ${modeGuidance.equity_mover_reaction}`
};

export const analystPromptLibrary = (Object.keys(systemPromptByMode) as AnalysisMode[]).reduce(
  (library, mode) => {
    library[mode] = {
      mode,
      publicOutput: isPublicMode(mode),
      systemPrompt: systemPromptByMode[mode],
      userPromptTemplate: createUserPrompt,
      inputSchema: analystPromptInputSchema,
      outputSchema: mode === "x_short" ? xShortOutputSchema : analystPromptOutputSchema,
      outputJsonSchema: mode === "x_short" ? xShortOutputJsonSchema : baseOutputJsonSchema
    };
    return library;
  },
  {} as Record<AnalysisMode, AnalystPromptDefinition>
);

export function getAnalystPromptDefinition(mode: AnalysisMode): AnalystPromptDefinition {
  return analystPromptLibrary[mode] ?? analystPromptLibrary.public_telegram;
}

export function createUserPrompt(input: AnalystPromptInput): string {
  return [
    `Mode: ${input.mode}`,
    `Subject: ${input.subject}`,
    `Asset class: ${input.assetClass}`,
    `Style: ${input.styleInstruction}`,
    "",
    "Write from the following structured evidence only.",
    JSON.stringify(
      {
        snapshot: input.snapshot,
        primaryCatalyst: input.primaryCatalyst,
        catalysts: input.catalysts,
        confidence: input.confidence,
        facts: input.facts,
        evidence: input.evidence,
        sources: input.sources,
        requiredPublicFooter: input.publicFooter
      },
      null,
      2
    ),
    "",
    "Return JSON only with: title, body, sourcesUsed."
  ].join("\n");
}
