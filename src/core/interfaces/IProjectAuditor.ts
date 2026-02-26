// Copyright 2026 Google LLC

/**
 * IProjectAuditor — the Open/Closed extension point for the auditor pipeline.
 *
 * Lives in the Core layer. Zero infrastructure imports.
 *
 * ## Open/Closed Principle in action
 *
 * RunCodeReview iterates an `IProjectAuditor[]` pipeline. To add a new auditor
 * (e.g. LicenseAuditor, DependencyAgeAuditor), you:
 *   1. Create a new class that implements IProjectAuditor.
 *   2. Register it in DependencyContainer.
 *   3. Done — zero changes to RunCodeReview or any other use case.
 *
 * Each auditor is responsible for ONE cross-cutting concern (SRP).
 */

import type { ReviewFinding } from "../entities/ReviewFinding.js";
import type {
  SecretFindingEntity,
  InfraFindingEntity,
} from "../entities/ProjectReport.js";
import type { CodeSegment } from "../entities/CodeSegment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared input handed to every auditor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AuditContext — the read-only view of the project that auditors receive.
 *
 * Auditors MUST NOT mutate this; they produce AuditResult values instead.
 */
export interface AuditContext {
  /** All scanned source files (with both original and minified content). */
  codeFiles: CodeSegment[];
  /** IaC files (Dockerfile, .tf, k8s yaml, etc.) keyed by relative path. */
  iacFiles: Record<string, string>;
  /** Package manifests (package.json, pom.xml, etc.) keyed by relative path. */
  dependencyManifests: Record<string, string>;
  /** Whether IaC analysis detected internet-facing infrastructure. */
  isPublicFacing: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output produced by each auditor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AuditResult — what each auditor returns.
 *
 * Fields are optional; an auditor only populates what it produces.
 */
export interface AuditResult {
  /** Static code / security findings (local SAST, no AI call). */
  codeFindings?: ReviewFinding[];
  /** Hardcoded secret detections. */
  secretFindings?: SecretFindingEntity[];
  /** IaC / SCA misconfigurations (may involve an AI call via IAiProvider). */
  infraFindings?: InfraFindingEntity[];
  /** Files scanned by this auditor (for display in the report). */
  scannedFiles?: string[];
  /** If this auditor determined internet-facing status, it can override. */
  isPublicFacing?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// IProjectAuditor — the contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IProjectAuditor
 *
 * A single, focused analysis step run as part of the auditor pipeline.
 *
 * Current implementations:
 *   - StaticSecurityAuditor  (regex-based secret detection, zero AI cost)
 *   - InfraStructureAuditor  (IaC/SCA via IAiProvider)
 *
 * Future extensions (no changes to RunCodeReview required):
 *   - LicenseAuditor         (checks SPDX identifiers in manifests)
 *   - DependencyAgeAuditor   (flags packages > N months old)
 *   - SBOMAuditor            (generates a CycloneDX SBOM)
 */
export interface IProjectAuditor {
  /**
   * Human-readable name for logging / spinner text.
   * Example: "Secrets pre-scan (SAST)"
   */
  readonly name: string;

  /**
   * Execute the audit.
   *
   * @param context  The project files available for analysis.
   * @returns        Findings produced by this auditor.
   */
  audit(context: AuditContext): Promise<AuditResult>;
}
