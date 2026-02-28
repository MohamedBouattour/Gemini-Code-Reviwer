// Copyright 2026 Google LLC

/**
 * CodeBenchmarkAuditor — local code quality benchmark, zero AI cost.
 *
 * Implements IProjectAuditor so it plugs into the auditor pipeline
 * in DependencyContainer with zero changes to RunCodeReview.
 *
 * ## SRP
 *   This class is ONLY responsible for:
 *     1. Delegating to three pure analyzers.
 *     2. Mapping their results into the AuditResult shape.
 *   It does NOT implement any analysis algorithm itself.
 *
 * ## Analyzers (each has its own SRP)
 *   ┌─ ComplexityAnalyzer    → cyclomatic complexity per function
 *   ├─ DuplicationAnalyzer   → duplicate code blocks (rolling-hash)
 *   └─ NamingConventionAnalyzer → identifier naming convention violations
 *
 * ## Output
 *   - codeFindings: naming violations + complexity hotspots → ReviewFinding[]
 *   - localBenchmarks stored on AuditResult.benchmarks (new optional field)
 *   - No secretFindings, no infraFindings
 *
 * ## Performance
 *   All three analyzers are synchronous and O(N) or O(N×W).
 *   Typical runtime on a 10 000-line TypeScript project: < 100 ms.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { ReviewFinding } from "../../core/entities/ReviewFinding.js";
import type { CodeBenchmarkResults } from "../../core/entities/CodeBenchmarkResults.js";
import { ComplexityAnalyzer } from "./ComplexityAnalyzer.js";
import { DuplicationAnalyzer } from "./DuplicationAnalyzer.js";
import { NamingConventionAnalyzer } from "./NamingConventionAnalyzer.js";

export class CodeBenchmarkAuditor implements IProjectAuditor {
  readonly name = "Code Quality Benchmark (local — complexity, duplication, naming)";

  private readonly complexityAnalyzer = new ComplexityAnalyzer();
  private readonly duplicationAnalyzer = new DuplicationAnalyzer();
  private readonly namingAnalyzer = new NamingConventionAnalyzer();

  async audit(context: AuditContext): Promise<AuditResult> {
    const { codeFiles, logDebug = () => {} } = context;

    logDebug(`[CodeBenchmarkAuditor] Analysing ${codeFiles.length} file(s)...`);

    // All three analyzers are synchronous — run sequentially (fast, no I/O)
    const complexity = this.complexityAnalyzer.analyze(codeFiles);
    const duplication = this.duplicationAnalyzer.analyze(codeFiles);
    const naming = this.namingAnalyzer.analyze(codeFiles);

    logDebug(
      `[CodeBenchmarkAuditor] Done:` +
        ` CC avg=${complexity.averageComplexity} max=${complexity.maxComplexity}` +
        ` hotspots=${complexity.hotspots.length} |` +
        ` dup=${duplication.duplicationPercentage}%` +
        ` (${duplication.duplicatedLines}/${duplication.totalLines} lines) |` +
        ` naming score=${naming.score}/100` +
        ` violations=${naming.totalViolations}/${naming.totalChecked}`,
    );

    const benchmarks: CodeBenchmarkResults = {
      complexity,
      duplication,
      naming,
      timestamp: new Date().toISOString(),
    };

    // ── Map to ReviewFindings so the report builder can surface them ──────────

    const codeFindings: ReviewFinding[] = [];

    // Complexity hotspots → high-priority findings
    for (const hotspot of complexity.hotspots) {
      codeFindings.push({
        file: hotspot.filePath,
        line: hotspot.startLine,
        snippet: hotspot.functionName,
        suggestion:
          `Function \`${hotspot.functionName}\` has cyclomatic complexity ${hotspot.complexity}` +
          ` (threshold: 10). Consider breaking it into smaller functions.`,
        category: "Complexity",
        priority: hotspot.complexity > 20 ? "high" : "medium",
      });
    }

    // Naming violations → low-priority findings
    for (const violation of naming.violations) {
      codeFindings.push({
        file: violation.filePath,
        line: violation.line,
        snippet: violation.actual,
        suggestion:
          `Naming violation (${violation.kind}): \`${violation.actual}\`` +
          ` should be \`${violation.expected}\`.`,
        category: "Naming",
        priority: "low",
      });
    }

    return {
      codeFindings,
      secretFindings: [],
      infraFindings: [],
      scannedFiles: codeFiles.map((f) => f.filePath),
      benchmarks,
    };
  }
}
