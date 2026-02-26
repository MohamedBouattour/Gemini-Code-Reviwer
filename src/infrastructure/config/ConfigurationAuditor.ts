// Copyright 2026 Google LLC

/**
 * ConfigurationAuditor — IaC/SCA auditor backed by the Gemini AI.
 *
 * Migration target: src/infra-auditor.ts → src/infrastructure/config/ConfigurationAuditor.ts
 *
 * ## Responsibilities (SRP)
 *   Audit Infrastructure-as-Code (IaC) files and dependency manifests for
 *   security misconfigurations. Delegates the AI call to IAiProvider so that
 *   GeminiProvider-specific logic stays in GeminiProvider.
 *
 * ## Clean Architecture
 *   - Implements IProjectAuditor (Core interface).
 *   - Depends on IAiProvider (Core interface) — NOT on GeminiProvider directly.
 *   - Registered in DependencyContainer as part of the auditor pipeline.
 *
 * ## Note
 *   This class supersedes InfraAuditorAdapter.ts for long-term use.
 *   InfraAuditorAdapter.ts remains until all callers are migrated.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";
import { detectPublicExposure } from "../security/exposureDetector.js";

// ─────────────────────────────────────────────────────────────────────────────
// ConfigurationAuditor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ConfigurationAuditor
 *
 * Runs as part of the IProjectAuditor pipeline (registered in DependencyContainer).
 * Performs AI-assisted audit of:
 *   - Dockerfile / docker-compose misconfigurations
 *   - Terraform / HCL security issues
 *   - Kubernetes / Helm chart issues
 *   - CI/CD pipeline security
 *   - Dependency SCA (Software Composition Analysis)
 */
export class ConfigurationAuditor implements IProjectAuditor {
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

    // Re-check internet-facing status from IaC file content
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
