import { z } from "zod";

export const complianceFlagSchema = z.object({
  code: z.string(),
  severity: z.enum(["low", "medium", "high", "block"]),
  phrase: z.string(),
  message: z.string()
});
export type ComplianceFlag = z.infer<typeof complianceFlagSchema>;

export const complianceResultSchema = z.object({
  status: z.enum(["approved", "rewritten", "review_required", "blocked"]),
  flags: z.array(complianceFlagSchema),
  originalText: z.string(),
  finalText: z.string()
});
export type ComplianceResult = z.infer<typeof complianceResultSchema>;

export interface ComplianceOptions {
  confidenceScore?: number;
  sourceCount?: number;
  publicOutput?: boolean;
}

interface Rule {
  code: string;
  pattern: RegExp;
  severity: ComplianceFlag["severity"];
  message: string;
  replacement: string;
}

const rules: Rule[] = [
  {
    code: "buy_sell_advice",
    pattern: /\bmust buy\b|\bload up\b|\bbuy\b|\bsell\b|\blong this\b|\bshort this\b/gi,
    severity: "block",
    message: "Blocks direct trading advice and directional positioning language.",
    replacement: "market interest"
  },
  {
    code: "signal_language",
    pattern: /\bentry\b|\bsignal\b|\btarget\b/gi,
    severity: "high",
    message: "Blocks trading signal vocabulary.",
    replacement: "market level"
  },
  {
    code: "pump_language",
    pattern: /\bpump\b|\bmoon\b|\beasy money\b/gi,
    severity: "high",
    message: "Blocks promotional or hype language.",
    replacement: "momentum"
  },
  {
    code: "guaranteed_performance",
    pattern: /\bguaranteed\b|\brisk-free\b|100%|\bthis will definitely\b/gi,
    severity: "block",
    message: "Blocks guaranteed performance and unsupported certainty.",
    replacement: "would require confirmation"
  },
  {
    code: "financial_advice",
    pattern: /\bfinancial advice\b/gi,
    severity: "block",
    message: "Public market commentary must not present itself as financial advice.",
    replacement: "market commentary"
  }
];

const neutralRewrites: Array<[RegExp, string]> = [
  [/\bthe reason is\b/gi, "the move appears linked to"],
  [/\bwill definitely\b/gi, "may"],
  [/\bmust buy\b/gi, "is drawing market interest"],
  [/\bload up\b/gi, "market participation has increased"],
  [/\bbuy\b/gi, "market interest in"],
  [/\bsell\b/gi, "downside pressure in"],
  [/\blong this\b/gi, "supported by the current setup"],
  [/\bshort this\b/gi, "pressured by the current setup"],
  [/\bentry\b/gi, "market level"],
  [/\bsignal\b/gi, "market read"],
  [/\btarget\b/gi, "reference level"],
  [/\bpump\b/gi, "momentum"],
  [/\bmoon\b/gi, "extend"],
  [/\bguaranteed\b/gi, "not yet confirmed"],
  [/\brisk-free\b/gi, "risk-sensitive"],
  [/100%/gi, "high-conviction"],
  [/\beasy money\b/gi, "a favorable setup"],
  [/\bfinancial advice\b/gi, "market commentary"]
];

export class ComplianceEngine {
  review(text: string, options: ComplianceOptions = {}): ComplianceResult {
    const flags = this.scan(text, options);
    const rewrittenText = this.rewrite(text);
    const finalText = options.publicOutput ? ensurePublicDisclaimer(rewrittenText) : rewrittenText;

    if (flags.length === 0) {
      return {
        status: "approved",
        flags,
        originalText: text,
        finalText
      };
    }

    const hasBlocking = flags.some((flag) => flag.severity === "block");
    const hasHigh = flags.some((flag) => flag.severity === "high");
    const changed = finalText !== text;

    if (hasBlocking && !changed) {
      return {
        status: "blocked",
        flags,
        originalText: text,
        finalText: ""
      };
    }

    if (hasBlocking || hasHigh) {
      return {
        status: "rewritten",
        flags,
        originalText: text,
        finalText
      };
    }

    return {
      status: "review_required",
      flags,
      originalText: text,
      finalText
    };
  }

  scan(text: string, options: ComplianceOptions = {}): ComplianceFlag[] {
    const flags: ComplianceFlag[] = [];
    for (const rule of rules) {
      const matches = text.match(rule.pattern);
      if (!matches) {
        continue;
      }
      for (const phrase of [...new Set(matches.map((match) => match.toLowerCase()))]) {
        flags.push({
          code: rule.code,
          severity: rule.severity,
          phrase,
          message: rule.message
        });
      }
    }

    if ((options.sourceCount ?? 1) === 0) {
      flags.push({
        code: "weak_sourcing",
        severity: "medium",
        phrase: "no sources",
        message: "Public commentary needs at least one source or structured data input."
      });
    }

    if ((options.confidenceScore ?? 100) < 50) {
      flags.push({
        code: "low_confidence",
        severity: "medium",
        phrase: "confidence below 50",
        message: "Weak explanations must use cautious language or be held for review."
      });
    }

    return flags;
  }

  rewrite(text: string): string {
    return neutralRewrites.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
  }
}

export function ensurePublicDisclaimer(text: string): string {
  const normalized = text.trim();
  if (normalized.endsWith("Market commentary only.")) {
    return normalized;
  }
  return `${normalized}\n\nMarket commentary only.`;
}
