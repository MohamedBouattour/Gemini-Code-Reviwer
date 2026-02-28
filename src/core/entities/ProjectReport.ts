// Copyright 2026 Google LLC

/**
 * ProjectReport — the aggregated output of a full code review run.
 *
 * Lives in the Core layer. Produced by RunCodeReview, consumed by IReportBuilder.
 */

import type { ReviewFinding } from "./ReviewFinding.js";
import type { CodeBenchmarkResults } from "./CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Supporting types
// ─────────────────────────────────────────────────────────────────────────────

export type SecretSeverity = "critical" | "high";
export type InfraSeverity = "critical" | "high" | "medium" | "low";

export interface SecretFindingEntity {
  file: string;
  line: number;
  patternType: string;
  label: string;
  snippet: string;
  severity: SecretSeverity;
}

export interface InfraFindingEntity {
  file: string;
  line?: number;
  category: string;
  title: string;
  description: string;
  remediation: string;
  severity: InfraSeverity;
}

export interface ExecutiveSummary {
  what: string;
  impact: string;
  risk: string;
  isPublicFacing: boolean;
}

/**
 * AI sub-scores — kept for backward compatibility with the cache schema.
 * Now populated by the local CodeBenchmarkAuditor instead of the AI.
 * @deprecated Use ProjectReport.localBenchmarks instead for new code.
 */
export interface AiSubScores {
  namingConventionScore?: number;
  solidPrinciplesScore?: number;
  codeDuplicationPercentage?: number;
  cyclomaticComplexity?: number;
  maintainabilityIndex?: number;
}

export interface TimingStats {
  totalMs: number;
  scanMs: number;
  auditMs: number;
  reviewMs: number;
  summaryMs: number;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectReport
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectReport {
  codeFindings: ReviewFinding[];
  secretFindings: SecretFindingEntity[];
  infraFindings: InfraFindingEntity[];
  isPublicFacing: boolean;
  infraScannedFiles: string[];
  executiveSummary?: ExecutiveSummary;
  /** @deprecated use localBenchmarks */
  aiSubScores?: AiSubScores;
  /**
   * Local benchmark metrics — computed without any AI call.
   * Populated by CodeBenchmarkAuditor.
   */
  localBenchmarks?: CodeBenchmarkResults;
  fileHashes: Record<string, string>;
  timingStats?: TimingStats;
}
