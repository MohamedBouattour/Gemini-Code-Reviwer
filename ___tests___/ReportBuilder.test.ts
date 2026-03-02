import { describe, it, expect, beforeEach } from "vitest";
import { ReportBuilder } from "../src/presentation/report/ReportBuilder.js";

describe("ReportBuilder", () => {
  let builder: any;

  beforeEach(() => {
    builder = new ReportBuilder();
  });

  it("adds findings and calculates scores (deduplication applied)", () => {
    builder.addAiFindings([
      { file: "a.ts", priority: "high", snippet: "x", suggestion: "Issue A" }, // -10
      { file: "b.ts", priority: "low", snippet: "y", suggestion: "Issue B" }, // -1
    ]);

    // 100 - 10 - 1 = 89
    expect(builder.calculateFinalScore()).toBe(89);
  });

  it("merges identical findings into one aggregated entry", () => {
    builder.addAiFindings([
      {
        file: "a.ts",
        priority: "high",
        snippet: "x",
        suggestion: "Same Issue",
      },
      { file: "b.ts", priority: "low", snippet: "y", suggestion: "Same Issue" },
    ]);

    // Escalates to high, penalty for only 1 unique finding = 10
    expect(builder.calculateFinalScore()).toBe(90);
  });

  it("applies public-facing multiplier", () => {
    builder.addInfrastructureResults({
      findings: [],
      isPublicFacing: true,
      scannedFiles: ["infra.yaml"],
    });

    // 100 * 0.93 = 93
    expect(builder.calculateFinalScore()).toBe(93);
  });

  it("handles secret findings", () => {
    builder.addSecretResults([
      {
        file: "env",
        severity: "critical",
        label: "AWS",
        snippet: "...",
        patternType: "aws",
      }, // -20
    ]);

    // 100 - 20 = 80
    expect(builder.calculateFinalScore()).toBe(80);
  });

  it("builds a markdown report", () => {
    builder.addAiFindings([
      { file: "test.ts", priority: "high", suggestion: "Fix it", line: 1 },
    ]);
    builder.setExecutiveSummary({
      what: "A",
      impact: "B",
      risk: "C",
      isPublicFacing: false,
    });

    const report = builder.build();
    expect(report).toContain("# 🤖 AI Code Review Report");
    expect(report).toContain("### 🔍 The What");
    expect(report).toContain("Fix it");
  });
});
