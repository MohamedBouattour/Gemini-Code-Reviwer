import { describe, it, expect } from "vitest";
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  INFRA_REVIEW_SYSTEM_PROMPT,
  EXECUTIVE_SUMMARY_PROMPT,
} from "../src/infrastructure/ai/prompts.js";

describe("Prompts Builder", () => {
  it("builds the code review system prompt", () => {
    const prompt = CODE_REVIEW_SYSTEM_PROMPT("Custom skills", "Feedback");
    expect(prompt).toContain("Security Researcher");
    expect(prompt).toContain("Custom skills");
    expect(prompt).toContain("Feedback");
    expect(prompt).toContain("SOLID");
    expect(prompt).toContain("Clean Code");
  });

  it("builds the infrastructure review system prompt", () => {
    const prompt = INFRA_REVIEW_SYSTEM_PROMPT;
    expect(prompt).toContain("DevSecOps engineer");
    expect(prompt).toContain("Container Security");
    expect(prompt).toContain("IaC");
    expect(prompt).toContain("SCA");
  });

  it("builds the executive summary prompt", () => {
    const input: any = {
      overallScore: 85,
      totalCodeFindings: 10,
      totalSecrets: 1,
      totalInfraFindings: 2,
      isPublicFacing: true,
      sampleFiles: ["a.ts"],
      topHighFindings: ["finding A"],
      topInfraFindings: ["infra X"],
    };
    const prompt = EXECUTIVE_SUMMARY_PROMPT(input);
    expect(prompt).toContain("Overall Score (Priority-Weighted): 85/100");
    expect(prompt).toContain("Internet-facing: true");
    expect(prompt).toContain("finding A");
    expect(prompt).toContain("infra X");
  });
});
