import { describe, expect, it } from "vitest";
import { ComplianceEngine } from "../src";

describe("ComplianceEngine", () => {
  const engine = new ComplianceEngine();

  it("rewrites direct advice and guaranteed language into neutral commentary", () => {
    const result = engine.review("This is a must buy and guaranteed 100% easy money.", {
      publicOutput: true,
      sourceCount: 1,
      confidenceScore: 80
    });

    expect(result.status).toBe("rewritten");
    expect(result.finalText.toLowerCase()).not.toContain("must buy");
    expect(result.finalText.toLowerCase()).not.toContain("guaranteed");
    expect(result.finalText).toContain("Market commentary only.");
  });

  it("approves neutral sourced market language", () => {
    const result = engine.review("NVDA is supported by earnings context and sector strength.", {
      sourceCount: 2,
      confidenceScore: 86
    });

    expect(result.status).toBe("approved");
    expect(result.flags).toHaveLength(0);
  });

  it("flags weak sourcing and low confidence", () => {
    const result = engine.review("The move appears linked to broad risk appetite.", {
      sourceCount: 0,
      confidenceScore: 35
    });

    expect(result.status).toBe("review_required");
    expect(result.flags.map((flag) => flag.code)).toEqual(expect.arrayContaining(["weak_sourcing", "low_confidence"]));
  });
});
