// Copyright 2026 Google LLC

/**
 * InfraAuditorAdapter — DEPRECATED / NO-OP.
 *
 * Infrastructure and SCA analysis is now part of the unified
 * IAiProvider.reviewProject() call in GeminiProvider.
 * This file is kept as a placeholder to avoid breaking existing imports
 * in the DependencyContainer; it contributes zero findings.
 *
 * TODO: Remove this file and its registration in DependencyContainer
 *       in a future cleanup pass.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";

export class InfraAuditorAdapter implements IProjectAuditor {
  readonly name = "Infrastructure & Dependency Audit (IaC/SCA)";

  constructor(private readonly aiProvider: IAiProvider) {}

  /**
   * No-op: infra findings are now returned by reviewProject() in the main AI call.
   */
  async audit(context: AuditContext): Promise<AuditResult> {
    void context;
    void this.aiProvider;
    return {
      infraFindings: [],
      scannedFiles: [],
      isPublicFacing: undefined,
    };
  }
}
