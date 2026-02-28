// Copyright 2026 Google LLC

/**
 * IProjectAuditor — pipeline step interface.
 *
 * Each auditor receives an AuditContext (project snapshot) and returns
 * an AuditResult contributing findings to the final report.
 *
 * AuditContext now carries `logDebug` so auditors that run AI calls
 * (e.g. InfraAuditorAdapter) can emit properly prefixed debug lines
 * without depending on the Logger utility directly.
 */

import type { CodeSegment } from "../entities/CodeSegment.js";
import type { ReviewFinding } from "../entities/ReviewFinding.js";
import type { SecretFindingEntity, InfraFindingEntity } from "../entities/ProjectReport.js";

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
  /**
   * Optional debug logger injected by RunCodeReview.
   * Auditors should use this instead of console.log so output respects
   * the --debug flag and is consistently prefixed.
   */
  logDebug?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuditResult
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditResult {
  codeFindings?: ReviewFinding[];
  secretFindings?: SecretFindingEntity[];
  infraFindings?: InfraFindingEntity[];
  /** Paths of files that were scanned (for the report's scanned-files list). */
  scannedFiles?: string[];
  /** Override public-facing status if the auditor can determine it. */
  isPublicFacing?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// IProjectAuditor
// ─────────────────────────────────────────────────────────────────────────────

export interface IProjectAuditor {
  /** Human-readable name shown in progress spinner and debug output. */
  readonly name: string;
  audit(context: AuditContext): Promise<AuditResult>;
}
