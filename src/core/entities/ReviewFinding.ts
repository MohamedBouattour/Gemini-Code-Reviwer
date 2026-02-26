// Copyright 2026 Google LLC

/**
 * ReviewFinding — canonical domain entity for a single code finding.
 *
 * Lives in the Core layer. Zero dependencies on infrastructure or frameworks.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Value Objects
// ─────────────────────────────────────────────────────────────────────────────

export type FindingPriority = "low" | "medium" | "high";

/**
 * A before/after code pair for HIGH-severity Security findings.
 * Rendered as a ```diff block in the final report.
 */
export interface RecommendedFix {
  /** The vulnerable / problematic code as-is (1–4 lines). */
  before: string;
  /** The corrected / secure replacement (1–4 lines). */
  after: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Entity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ReviewFinding — a single issue identified by the AI or a static auditor.
 *
 * This is the canonical form that flows through the entire pipeline:
 *   IAiProvider → RunCodeReview → IReportBuilder
 */
export interface ReviewFinding {
  /** Relative file path where the issue was found. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** A short, specific code excerpt that triggered the finding. */
  snippet: string;
  /** Actionable description of the issue and how to fix it. */
  suggestion: string;
  /** High-level category (e.g. "Security/Injection", "SOLID", "Naming"). */
  category?: string;
  /** Triage priority. */
  priority: FindingPriority;
  /**
   * Exposure multiplier set after path risk analysis.
   * Public-facing files get a higher multiplier to amplify score penalties.
   */
  riskMultiplier?: number;
  /** Optional before/after fix for HIGH security findings. */
  recommendedFix?: RecommendedFix;
}
