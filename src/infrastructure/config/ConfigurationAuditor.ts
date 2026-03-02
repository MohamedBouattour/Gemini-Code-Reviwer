// Copyright 2026 Google LLC

/**
 * ConfigurationAuditor — DEPRECATED / NO-OP.
 *
 * Infrastructure and SCA analysis is now part of the unified
 * IAiProvider.reviewProject() call in GeminiProvider.
 * This file is kept as a placeholder to avoid breaking existing imports;
 * it contributes zero findings.
 *
 * ## Previous responsibility
 *   Audit IaC files and dependency manifests for security misconfigurations
 *   (Dockerfiles, Terraform, K8s/Helm, CI/CD pipelines, SCA).
 *   That analysis now happens inside reviewProject() so the full codebase
 *   context is available in a single LLM call.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";

export class ConfigurationAuditor implements IProjectAuditor {
  readonly name = "Infrastructure & Dependency Audit (IaC/SCA)";

  constructor(private readonly aiProvider: IAiProvider) {}

  /**
   * No-op: infra findings are now returned by reviewProject() in the main AI call.
   */
  async audit(context: AuditContext): Promise<AuditResult> {
    void context;
    void this.aiProvider; // kept for interface compatibility
    return {
      infraFindings: [],
      scannedFiles: [],
      isPublicFacing: undefined,
    };
  }
}
