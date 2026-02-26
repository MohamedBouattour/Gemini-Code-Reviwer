// Copyright 2026 Google LLC

/**
 * InfraAuditorAdapter — IProjectAuditor for IaC/SCA security analysis.
 *
 * Delegates the actual AI call to IAiProvider.auditInfrastructure().
 * This keeps infrastructure concerns (Gemini API) in GeminiProvider,
 * and orchestration concerns in RunCodeReview.
 *
 * Plugs into the auditor pipeline — adding another infrastructure-based auditor
 * requires zero changes to RunCodeReview.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";
import { detectPublicExposure } from "../security/exposureDetector.js";

export class InfraAuditorAdapter implements IProjectAuditor {
  readonly name = "Infrastructure & Dependency Audit (IaC/SCA)";

  constructor(private readonly aiProvider: IAiProvider) {}

  async audit(context: AuditContext): Promise<AuditResult> {
    const infraFindings = await this.aiProvider.auditInfrastructure(
      context.iacFiles,
      context.dependencyManifests,
    );

    const scannedFiles = [
      ...Object.keys(context.iacFiles),
      ...Object.keys(context.dependencyManifests),
    ];

    // Re-check internet-facing status from CI file content
    const ciContents = Object.values(context.iacFiles);
    const isPublicFacing =
      context.isPublicFacing || detectPublicExposure(ciContents);

    return {
      infraFindings,
      scannedFiles,
      isPublicFacing,
    };
  }
}
