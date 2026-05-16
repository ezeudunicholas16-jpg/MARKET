import { ComplianceResult } from "@market-desk/compliance";
import { AnalysisDraft, MarketSnapshot } from "@market-desk/shared";

export type PublishingMode = "auto_post" | "approval_required";
export type PublishingDecisionStatus = "auto_post_allowed" | "approval_required" | "blocked";

export interface PublishingDecisionInput {
  mode: PublishingMode;
  draft: AnalysisDraft;
  compliance: ComplianceResult;
  snapshot: MarketSnapshot;
}

export interface PublishingDecision {
  mode: PublishingMode;
  status: PublishingDecisionStatus;
  confidenceScore: number;
  cautiousLanguageRequired: boolean;
  reasons: string[];
  warnings: string[];
}

const cautiousLanguagePattern =
  /\b(appears|looks|may|could|would|depends|not yet confirmed|available sources|at the time of writing|risk is)\b/i;

export function evaluatePublishingDecision(input: PublishingDecisionInput): PublishingDecision {
  const confidence = input.draft.confidence.score;
  const hasHighRiskCompliance = input.compliance.flags.some(
    (flag) => flag.severity === "high" || flag.severity === "block"
  );
  const hasSourceWarning = hasMissingOrStaleSourceWarning(input.snapshot);
  const isNoConfirmedCatalyst = input.draft.catalyst.classification === "no_confirmed_catalyst";
  const hasCautiousLanguage = cautiousLanguagePattern.test(input.draft.body);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let status: PublishingDecisionStatus = "auto_post_allowed";
  let cautiousLanguageRequired = false;

  if (input.mode === "approval_required") {
    status = "approval_required";
    reasons.push("Publishing mode requires manual approval.");
  }

  if (hasHighRiskCompliance) {
    status = "approval_required";
    reasons.push("High-risk compliance flag requires manual approval.");
    warnings.push("Compliance review found high-risk language.");
  }

  if (hasSourceWarning && !isNoConfirmedCatalyst) {
    status = "approval_required";
    reasons.push("Missing or stale source warning requires manual approval.");
    warnings.push("Live source coverage is missing or stale.");
  }

  if (confidence >= 85) {
    if (input.compliance.flags.length === 0 && status !== "approval_required") {
      reasons.push("Confidence is at least 85 and compliance is clear.");
    } else if (input.compliance.flags.length > 0) {
      status = "approval_required";
      reasons.push("Compliance flags are present despite high confidence.");
    }
  } else if (confidence >= 65) {
    cautiousLanguageRequired = true;
    if (!hasCautiousLanguage) {
      status = "approval_required";
      reasons.push("Confidence is 65-84, but cautious language is missing.");
    } else if (status !== "approval_required") {
      reasons.push("Confidence is 65-84 and cautious language is present.");
    }
  } else if (confidence >= 45) {
    status = "approval_required";
    reasons.push("Confidence is 45-64; save as draft for approval.");
  } else if (!isNoConfirmedCatalyst) {
    status = "blocked";
    reasons.push("Confidence is below 45 and the draft is not in no_confirmed_catalyst format.");
  } else {
    cautiousLanguageRequired = true;
    if (status !== "approval_required") {
      reasons.push("Confidence is below 45, but no_confirmed_catalyst format allows cautious admin review.");
    }
  }

  return {
    mode: input.mode,
    status,
    confidenceScore: confidence,
    cautiousLanguageRequired,
    reasons,
    warnings
  };
}

export function hasMissingOrStaleSourceWarning(snapshot: MarketSnapshot): boolean {
  return snapshot.sources.some((source) => source.id === "src-live-source-warning");
}
