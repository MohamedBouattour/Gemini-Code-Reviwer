import { describe, it, expect, beforeEach } from "vitest";
import chalk from "chalk";
import { ReportBuilder, generateMarkdownReport } from "../src/presentation/report/ReportBuilder.js";
import type { ReviewFinding } from "../src/core/entities/ReviewFinding.js";
import type { CodeBenchmarkResults } from "../src/core/entities/CodeBenchmarkResults.js";

describe("ReportBuilder", () => {
  let builder: ReportBuilder;

  beforeEach(() => {
    builder = new ReportBuilder();
  });

  it("adds findings and calculates scores (deduplication applied)", () => {
    builder.addAiFindings([
      { file: "a.ts", line: 1, snippet: "x", priority: "high", suggestion: "Issue A" }, // -10
      { file: "b.ts", line: 1, snippet: "y", priority: "low", suggestion: "Issue B" }, // -1
    ]);

    // 100 - 10 - 1 = 89
    expect(builder.calculateFinalScore()).toBe(89);
  });

  it("merges identical findings into one aggregated entry", () => {
    builder.addAiFindings([
      {
        file: "a.ts",
        line: 1,
        snippet: "x",
        priority: "high",
        suggestion: "Same Issue",
      },
      { file: "b.ts", line: 2, snippet: "y", priority: "low", suggestion: "Same Issue" },
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
        line: 1,
        severity: "critical",
        label: "AWS",
        snippet: "...",
        patternType: "aws",
      }, // -20
    ]);

    // 100 - 20 = 80
    expect(builder.calculateFinalScore()).toBe(80);
  });

  it("builds a markdown report with all sections", () => {
    builder.addAiFindings([
      { 
        file: "test.ts", 
        priority: "high", 
        suggestion: "High issue", 
        line: 1, 
        category: "Security",
        snippet: "eval(x)",
        recommendedFix: { before: "eval(x)", after: "JSON.parse(x)" }
      },
      { 
        file: "other.ts", 
        priority: "medium", 
        suggestion: "Medium issue", 
        line: 5,
        snippet: "var x = 1;"
      },
      { 
        file: "style.ts", 
        priority: "low", 
        suggestion: "Low issue", 
        line: 10,
        snippet: "console.log(1)"
      }
    ]);
    builder.addSecretResults([
      {
        file: ".env",
        severity: "critical",
        label: "API Key",
        snippet: "AKIA...",
        line: 1,
        patternType: "aws"
      }
    ]);
    builder.addInfrastructureResults({
      findings: [
        {
          file: "Dockerfile",
          severity: "high",
          title: "Root user",
          description: "Don't use root",
          remediation: "Use USER node",
          category: "Security"
        }
      ],
      isPublicFacing: true,
      scannedFiles: ["Dockerfile", "package.json"]
    });
    builder.setExecutiveSummary({
      what: "Project summary",
      impact: "High impact",
      risk: "Severe risk",
      isPublicFacing: true,
    });
    builder.setAiScores({
      namingConventionScore: 80,
      solidPrinciplesScore: 70,
      codeDuplicationPercentage: 5,
      cyclomaticComplexity: 3,
      maintainabilityIndex: 90
    });
    builder.setLocalBenchmarks({
      complexity: {
        averageComplexity: 2.5,
        maxComplexity: 10,
        totalFunctions: 100,
        hotspots: [{ name: "fn", complexity: 12, line: 10 }] as unknown as Array<{ name: string; complexity: number; line: number }>
      },
      duplication: {
        duplicationPercentage: 4.2,
        duplicatedLines: 42,
        totalLines: 1000,
        topBlocks: []
      },
      naming: {
        score: 85,
        totalChecked: 200,
        totalViolations: 5,
        violations: []
      },
      timestamp: "now"
    } as unknown as CodeBenchmarkResults);
    builder.setTimingStats({
      totalMs: 5000,
      scanMs: 500,
      auditMs: 3000,
      summaryMs: 1500,
      timestamp: "2026-03-02T10:00:00.000Z"
    });

    const report = builder.build(false);
    expect(report).toContain("# 🤖 AI Code Review Report");
    expect(report).toContain("## 📋 Executive Summary");
    expect(report).toContain("## 📊 Scores");
    expect(report).toContain("## 🔐 Secrets & Credentials Detected");
    expect(report).toContain("## 🏗️ Infrastructure & Dependency Audit");
    expect(report).toContain("## 🕵️ Code Review Findings");
    expect(report).toContain("## 📈 Project Metrics (Local Analysis)");
    expect(report).toContain("## ⏱️ Pipeline Timing");
    expect(report).toContain("High issue");
    expect(report).toContain("Medium issue");
    expect(report).toContain("Low issue");
    expect(report).toContain("Recommended Fix");
  });

  it("renders with chalk when useChalk is true", () => {
    chalk.level = 1;
    builder.addAiFindings([{ file: "test.ts", priority: "high", suggestion: "High issue", line: 1, snippet: "s" }]);
    const report = builder.build(true);
    // Chalk codes start with \u001b
    expect(report).toContain("\u001b[");
  });

  it("handles empty findings gracefully", () => {
    const report = builder.build();
    expect(report).toContain("No code findings! Excellent code structure.");
  });

  it("supports fromCachedResponse correctly", () => {
    const cached = {
      score: 85,
      findings: [{ file: "a.ts", priority: "low", suggestion: "low", line: 1, snippet: "s" }],
      namingConventionScore: 90,
      codeDuplicationPercentage: 0,
      cyclomaticComplexity: 1,
      maintainabilityIndex: 100
    };
    const b = ReportBuilder.fromCachedResponse(cached as any).build();
    expect(b).toContain("Overall (Priority-Weighted)");
  });

  it("calculates complex scores correctly with weights", () => {
    // 100 (base)
    builder.addAiFindings([
      { file: "a.ts", line: 1, snippet: "s", priority: "high", suggestion: "H" }, // -10
      { file: "b.ts", line: 1, snippet: "s", priority: "medium", suggestion: "M" }, // -3
      { file: "c.ts", line: 1, snippet: "s", priority: "low", suggestion: "L" }, // -1
    ]);
    builder.addSecretResults([
      { file: "f1", line: 1, snippet: "s", label: "l", patternType: "p", severity: "critical" }, // -20
      { file: "f2", line: 1, snippet: "s", label: "l", patternType: "p", severity: "high" }, // -10
    ]);
    const infraFindings = [
      { file: "i1", severity: "critical" as const, title: "t", description: "d", remediation: "r", category: "c" }, // -20
      { file: "i2", severity: "high" as const, title: "t", description: "d", remediation: "r", category: "c" }, // -10
      { file: "i3", severity: "medium" as const, title: "t", description: "d", remediation: "r", category: "c" }, // -5
      { file: "i4", severity: "low" as const, title: "t", description: "d", remediation: "r", category: "c" }, // -1
    ];
    builder.addInfrastructureResults({
      findings: infraFindings,
      isPublicFacing: false,
      scannedFiles: []
    });
    
    // Total penalty: (10+3+1) + (20+10) + (20+10+5+1) = 14 + 30 + 36 = 80
    // Score: 100 - 80 = 20
    expect(builder.calculateFinalScore()).toBe(20);

    // Apply public facing multiplier WITHOUT clearing findings
    builder.addInfrastructureResults({ 
      findings: infraFindings, 
      isPublicFacing: true, 
      scannedFiles: [] 
    });
    // 20 * 0.93 = 18.6 -> 19
    expect(builder.calculateFinalScore()).toBe(19);
  });

  it("provides risk level labels correctly", () => {
    // Score 100 -> Low Risk
    expect(builder.build()).toContain("🟢 Low Risk");

    // Deduct 40 -> Score 60 -> Moderate
    builder.addAiFindings([
      { file: "a.ts", line: 1, snippet: "s", priority: "high", suggestion: "H1" }, // -10
      { file: "a.ts", line: 2, snippet: "s", priority: "high", suggestion: "H2" }, // -10
      { file: "a.ts", line: 3, snippet: "s", priority: "high", suggestion: "H3" }, // -10
      { file: "a.ts", line: 4, snippet: "s", priority: "high", suggestion: "H4" }, // -10
    ]);
    expect(builder.build()).toContain("🟡 Moderate");

    // Deduct 20 more -> Score 40 -> High Risk
    builder.addAiFindings([
      { file: "a.ts", line: 5, snippet: "s", priority: "high", suggestion: "H5" }, // -10
      { file: "a.ts", line: 6, snippet: "s", priority: "high", suggestion: "H6" }, // -10
    ]);
    expect(builder.build()).toContain("🟠 High Risk");

    // Deduct 10 more -> Score 30 -> Critical
    builder.addAiFindings([
      { file: "a.ts", line: 7, snippet: "s", priority: "high", suggestion: "H7" }, // -10
    ]);
    expect(builder.build()).toContain("🔴 Critical");
  });

  it("renders timing stats with individual calls if available", () => {
    builder.setTimingStats({
      totalMs: 1000,
      scanMs: 100,
      auditMs: 500,
      summaryMs: 400,
      auditInfraMs: 200,
      deepReviewMs: 300,
      timestamp: "now"
    });
    const report = builder.build();
    expect(report).toContain("auditInfra (Call 1)");
    expect(report).toContain("deepReview  (Call 2)");
  });

  it("renders complex aggregated findings with multiple locations", () => {
    builder.addAiFindings([
      { file: "a.ts", line: 1, snippet: "high", priority: "high", suggestion: "High unique" },
      { file: "b.ts", line: 2, snippet: "high", priority: "high", suggestion: "High unique" }, // same suggestion key
      { file: "c.ts", line: 3, snippet: "med", priority: "medium", suggestion: "Med unique" },
      { file: "d.ts", line: 4, snippet: "med", priority: "medium", suggestion: "Med unique" },
      { file: "e.ts", line: 5, snippet: "low", priority: "low", suggestion: "Low unique" },
      { file: "f.ts", line: 6, snippet: "low", priority: "low", suggestion: "Low unique" },
    ]);
    const report = builder.build();
    expect(report).toContain("2 locations"); // High
    expect(report).toContain("Affected locations:"); // Medium
    expect(report).toContain("f.ts:6"); // Low
  });

  it("renders collapsed infra findings for medium and low severity", () => {
    builder.addInfrastructureResults({
      findings: [
        { file: "m.yaml", severity: "medium", title: "M", description: "md", remediation: "mr", category: "c" },
        { file: "l.yaml", severity: "low", title: "L", description: "ld", remediation: "lr", category: "c" },
      ],
      isPublicFacing: false,
      scannedFiles: ["test.yaml"]
    });
    const report = builder.build();
    expect(report).toContain("<details>");
    expect(report).toContain("<summary>");
    expect(report).toContain("I1. 🟡 [MEDIUM]");
    expect(report).toContain("I2. 🔵 [LOW]");
  });

  it("renders 'No infra misconfigurations' message correctly", () => {
    builder.addInfrastructureResults({
      findings: [],
      isPublicFacing: false,
      scannedFiles: ["scanned.tf"]
    });
    const report = builder.build();
    expect(report).toContain("scanned.tf");
    expect(report).toContain("*No infrastructure misconfigurations found.* ✅");
  });

  it("supports fromCachedResponse with executiveSummary", () => {
    const cached = {
      findings: [],
      executiveSummary: { what: "W", impact: "I", risk: "R", isPublicFacing: false }
    };
    const b = ReportBuilder.fromCachedResponse(cached as any).build();
    expect(b).toContain("The What");
    expect(b).toContain("W");
  });

  it("supports generateMarkdownReport legacy function", () => {
    const data = {
      findings: [{ file: "a.ts", line: 1, snippet: "s", priority: "low", suggestion: "low" }] as unknown as ReviewFinding[],
      score: 99,
      codeDuplicationPercentage: 0,
      cyclomaticComplexity: 1,
      maintainabilityIndex: 100
    };
    const report = generateMarkdownReport(data as unknown as any);
    expect(report).toContain("# 🤖 AI Code Review Report");
  });
});
