import { AnalysisMode } from "@market-desk/shared";

export interface StyleValidationIssue {
  code: string;
  phrase: string;
  message: string;
}

export interface StyleValidationContext {
  mode: AnalysisMode;
  sourceIds?: string[];
  evidenceSummaries?: string[];
}

export interface StyleValidationResult {
  ok: boolean;
  issues: StyleValidationIssue[];
}

export class StyleValidationError extends Error {
  constructor(public readonly issues: StyleValidationIssue[]) {
    super(`Analyst style validation failed: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "StyleValidationError";
  }
}

const genericPhraseRules: Array<[RegExp, string]> = [
  [/\bas an ai\b/i, "Never refer to AI identity."],
  [/\bit is important to note\b/i, "Avoid generic ChatGPT transition phrases."],
  [/\bin today's (?:dynamic|fast-paced) market\b/i, "Avoid generic market boilerplate."],
  [/\bmarket participants are closely watching\b/i, "Avoid generic filler."],
  [/\binvestors should keep an eye on\b/i, "Avoid advice-like generic language."],
  [/\bonly time will tell\b/i, "Avoid vague non-analysis."],
  [/\bplays a crucial role\b/i, "Avoid generic explanatory filler."],
  [/\bnavigating (?:market )?volatility\b/i, "Avoid generic volatility boilerplate."],
  [/\bkey takeaway\b/i, "Avoid robotic headings and summaries in public copy."],
  [/\boverall sentiment\b/i, "Avoid unsupported sentiment language."],
  [/\bthe index read is\b/i, "Use natural market-context phrasing."],
  [/\bthe useful read is\b/i, "Use natural analyst phrasing."],
  [/\bthe right stance is caution\b/i, "Avoid advice-like canned phrasing."],
  [/\bthe desk would need\b/i, "Use 'A stronger explanation would require' instead."],
  [/\bavailable live sources at the time of writing\b/i, "Use current live sources phrasing."],
  [/\bthe source set\b/i, "Use current live sources phrasing."],
  [/\bsource set does not provide enough support\b/i, "Avoid mechanical source caveats."],
  [/\bstandalone confirmed story\b/i, "Use cleaner company-specific catalyst phrasing."]
];

const tradingLanguageRules: Array<[RegExp, string]> = [
  [/\bmust buy\b/i, "Direct trading advice is blocked."],
  [/\bload up\b/i, "Promotional positioning language is blocked."],
  [/\bbuy\b/i, "Buy language is blocked."],
  [/\bsell\b/i, "Sell language is blocked."],
  [/\blong this\b/i, "Positioning instructions are blocked."],
  [/\bshort this\b/i, "Positioning instructions are blocked."],
  [/\bentry\b/i, "Signal vocabulary is blocked."],
  [/\bsignal\b/i, "Signal vocabulary is blocked."]
];

const unsupportedCertaintyRules: Array<[RegExp, string]> = [
  [/\bguaranteed\b/i, "Guaranteed performance language is blocked."],
  [/\brisk-free\b/i, "Risk-free language is blocked."],
  [/\beasy money\b/i, "Promotional certainty is blocked."],
  [/\bthis will definitely\b/i, "Unsupported certainty is blocked."],
  [/\bis certain to\b/i, "Unsupported certainty is blocked."],
  [/\binevitable\b/i, "Unsupported certainty is blocked."],
  [/\bwithout doubt\b/i, "Unsupported certainty is blocked."],
  [/\b100%\b/i, "Unsupported absolute certainty is blocked."]
];

const overExplainerRules: Array<[RegExp, string]> = [
  [/\bstocks are shares\b/i, "Do not explain basic finance concepts."],
  [/\bforex is the exchange of currencies\b/i, "Do not explain basic finance concepts."],
  [/\bearnings are (?:a company's|company) profits\b/i, "Do not explain basic finance concepts."],
  [/\binterest rates are the cost of borrowing\b/i, "Do not explain basic finance concepts."],
  [/\binflation is (?:a )?rise in prices\b/i, "Do not explain basic finance concepts."],
  [/\ba commodity is a raw material\b/i, "Do not explain basic finance concepts."]
];

const internalArtifactRules: Array<[RegExp, string]> = [
  [/\bmock\b/i, "Public commentary must not expose provider mode or fixture language."],
  [/\bsource ids?\b/i, "Public commentary must not expose internal source identifiers."],
  [/\bjson\b/i, "Public commentary must not expose implementation details."],
  [/\bstructured feed\b/i, "Public commentary must not expose internal pipeline terminology."],
  [/\bprovider feed\b/i, "Public commentary must not expose provider plumbing."]
];

const roboticPublicHeadingRules = [
  /^(summary|analysis|market update|key takeaway|conclusion|overview):/im,
  /^\*\*(summary|analysis|market update|key takeaway|conclusion|overview)\*\*/im
];

export function validateAnalystStyle(text: string, context: StyleValidationContext): StyleValidationResult {
  const issues: StyleValidationIssue[] = [];

  collectMatches(text, genericPhraseRules, "generic_phrase", issues);
  collectMatches(text, tradingLanguageRules, "trading_language", issues);
  collectMatches(text, unsupportedCertaintyRules, "unsupported_certainty", issues);
  collectMatches(text, overExplainerRules, "over_explaining", issues);

  if (
    /\binvestors are optimistic\b/i.test(text) &&
    !hasEvidenceForInvestorOptimism(context.evidenceSummaries ?? [])
  ) {
    issues.push({
      code: "unsupported_sentiment",
      phrase: "investors are optimistic",
      message: "Investor sentiment claims need direct evidence such as positioning, flows, survey, or source commentary."
    });
  }

  const footerMatches = text.match(/Market commentary only\./g) ?? [];
  if (footerMatches.length > 1 || /\bnot financial advice\b/i.test(text)) {
    issues.push({
      code: "repetitive_disclaimer",
      phrase: footerMatches.length > 1 ? "Market commentary only." : "not financial advice",
      message: "Use only the required public footer once."
    });
  }

  if (isPublicMode(context.mode)) {
    collectMatches(text, internalArtifactRules, "internal_artifact", issues);

    for (const pattern of roboticPublicHeadingRules) {
      const match = text.match(pattern);
      if (match?.[0]) {
        issues.push({
          code: "robotic_public_heading",
          phrase: match[0],
          message: "Public commentary should read like desk commentary, not a templated report."
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export function assertAnalystStyle(text: string, context: StyleValidationContext): void {
  const result = validateAnalystStyle(text, context);
  if (!result.ok) {
    throw new StyleValidationError(result.issues);
  }
}

export function isPublicMode(mode: AnalysisMode): boolean {
  return mode !== "private_research" && mode !== "dashboard_brief";
}

function collectMatches(
  text: string,
  rules: Array<[RegExp, string]>,
  code: string,
  issues: StyleValidationIssue[]
): void {
  for (const [pattern, message] of rules) {
    const match = text.match(pattern);
    if (!match?.[0]) {
      continue;
    }

    issues.push({
      code,
      phrase: match[0],
      message
    });
  }
}

function hasEvidenceForInvestorOptimism(evidenceSummaries: string[]): boolean {
  return evidenceSummaries.some((summary) =>
    /\b(sentiment|positioning|fund flows?|survey|options flow|risk appetite|allocation|inflows?)\b/i.test(summary)
  );
}
