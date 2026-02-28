// Copyright 2026 Google LLC

/**
 * IProjectAuditor — pipeline step interface.
 *
 * Each auditor receives an AuditContext (project snapshot) and returns
 * an AuditResult contributing findings to the final report.
 *
 * AuditContext carries `logDebug` so AI-backed auditors can emit debug
 * lines without depending on the Logger utility directly.
 */

import type { CodeSegment } from "../entities/CodeSegment.js";
import type { ReviewFinding } from "../entities/ReviewFinding.js";
import type { SecretFindingEntity, InfraFindingEntity } from "../entities/ProjectReport.js";
import type { CodeBenchmarkResults } from "../entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// AuditContext
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditContext {
  /** Source code files (changed-only when incremental review is active). */
  codeFiles: CodeSegment[];
  /** IaC files keyed by relative path. */
  iacFiles: Record<string, string>;
  /** Dependency manifests keyed by filename. */
  dependencyManifests: Record<string, string>;
  /** True when IaC heuristics detect public internet exposure. */
  isPublicFacing: boolean;
  /** Optional debug logger — respects the --debug flag. */
  logDebug?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuditResult
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditResult {
  codeFindings?: ReviewFinding[];
  secretFindings?: SecretFindingEntity[];
  infraFindings?: InfraFindingEntity[];
  /** Paths of files scanned (for the report’s scanned-files list). */
  scannedFiles?: string[];
  /** Override public-facing status if the auditor can determine it. */
  isPublicFacing?: boolean;
  /**
   * Local benchmark metrics produced by CodeBenchmarkAuditor.
   * Merged into ProjectReport.localBenchmarks by RunCodeReview.
   */
  benchmarks?: CodeBenchmarkResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// IProjectAuditor
// ─────────────────────────────────────────────────────────────────────────────

export interface IProjectAuditor {
  readonly name: string;
  audit(context: AuditContext): Promise<AuditResult>;
}
