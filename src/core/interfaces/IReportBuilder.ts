// Copyright 2026 Google LLC

/**
 * IReportBuilder — the presentation layer contract.
 *
 * Uses types compatible with both the Core entity types and the legacy
 * infrastructure types to allow ReportBuilder.ts to implement this interface
 * without modification during the migration.
 *
 * The `build()` method is the single exit point: it produces a Markdown string.
 */

import type { ReviewFinding } from "../entities/ReviewFinding.js";
import type {
  SecretFindingEntity,
  InfraFindingEntity,
  ExecutiveSummary,
  AiSubScores,
  TimingStats,
} from "../entities/ProjectReport.js";

import type { CodeBenchmarkResults } from "../entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Supplementary input shape (passed to addInfrastructureResults)
// ─────────────────────────────────────────────────────────────────────────────

export interface InfrastructureResults {
  findings: InfraFindingEntity[];
  isPublicFacing: boolean;
  scannedFiles: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// IReportBuilder contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IReportBuilder — contract for the Markdown report builder.
 *
 * Callers feed data incrementally (findings, infra, secrets, scores),
 * then call `calculateFinalScore()` and `build()`.
 *
 * Score calculation and Markdown rendering are both the responsibility of
 * the implementation (MarkdownReportBuilder) — not the use case.
 */
export interface IReportBuilder {
  /** Ingest AI-generated code findings. Deduplication happens internally. */
  addAiFindings(findings: ReviewFinding[]): void;

  /** Feed the IaC/SCA audit result. */
  addInfrastructureResults(results: InfrastructureResults): void;

  /** Feed detected hardcoded secrets. */
  addSecretResults(secrets: SecretFindingEntity[]): void;

  /** Supply the AI-generated executive summary. */
  setExecutiveSummary(summary: ExecutiveSummary): void;

  /** Supply supplementary AI batch sub-scores. */
  setAiScores(scores: AiSubScores): void;

  /** Supply locally computed code quality benchmarks. */
  setLocalBenchmarks(benchmarks: CodeBenchmarkResults): void;

  /** Supply pipeline timing telemetry. */
  setTimingStats(stats: TimingStats): void;

  /**
   * Calculate the final repository score using the Priority Weight system.
   *
   * Formula (deterministic, transparent):
   *   base = 100
   *   − 10 per unique HIGH code finding
   *   −  3 per unique MEDIUM code finding
   *   −  1 per unique LOW code finding
   *   − 20 per CRITICAL secret / infra finding
   *   − 10 per HIGH secret / infra finding
   *   −  5 per MEDIUM secret / infra finding
   *   −  1 per LOW secret / infra finding
   *   × 0.93 if internet-facing
   *   clamped to [0, 100]
   */
  calculateFinalScore(): number;

  /**
   * Build and return the complete Markdown report string.
   * @param useChalk When true, ANSI colour codes are added for terminal output.
   */
  build(useChalk?: boolean): string;
}
