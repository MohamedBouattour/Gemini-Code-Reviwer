// Copyright 2026 Google LLC

/**
 * DependencyContainer — the Composition Root for Clean Architecture.
 *
 * This is the ONLY place in the codebase where concrete classes are
 * instantiated and dependencies are wired together. Everything else depends
 * on interfaces (IAiProvider, IFileScanner, IProjectAuditor, etc.).
 *
 * ## How to add a new IProjectAuditor (OCP in practice)
 *   1. Create `infrastructure/.../NewAuditor.ts` implementing IProjectAuditor.
 *   2. Add `new NewAuditor(...)` to the `auditors` array below.
 *   3. Done. RunCodeReview.ts is UNCHANGED.
 *
 * ## How to switch from Gemini to Claude
 *   1. Create `infrastructure/ai/ClaudeProvider.ts` implementing IAiProvider.
 *   2. Replace `new GeminiProvider(...)` with `new ClaudeProvider(...)` below.
 *   3. Done. The entire Application layer is UNCHANGED.
 */

// ── Infrastructure: AI ──────────────────────────────────────────────
//   Canonical path: infrastructure/ai/GeminiProvider.ts
//   Alias available at: infrastructure/ai/GeminiAiProvider.ts
import { GeminiProvider } from "../../infrastructure/ai/GeminiProvider.js";

// ── Infrastructure: Filesystem ──────────────────────────────────────────
//   NOTE: ProjectScanner implements the full IFileScanner contract
//   (iacFiles, configFiles, ciFiles, samples). FileSystemScanner is the
//   new Clean Architecture implementation (code files only). Until
//   ProjectScanner is fully absorbed, we wrap it here as an IFileScanner.
import { ProjectScanner } from "../../infrastructure/filesystem/ProjectScanner.js";
import type { ProjectContext } from "../../infrastructure/filesystem/ProjectScanner.js";
import type { ScannedProject } from "../../core/interfaces/IFileScanner.js";

// ── Infrastructure: Security/Config Auditors (OCP Pipeline) ──────────────
//   Canonical paths for each auditor.
import { StaticSecurityAuditor } from "../../infrastructure/security/StaticSecurityAuditor.js";
import { InfraAuditorAdapter } from "../../infrastructure/security/InfraAuditorAdapter.js";

// ── Infrastructure: Config ──────────────────────────────────────────────
import { LocalSkillRepository } from "../../infrastructure/config/LocalSkillRepository.js";

// ── Presentation: Report Builder ──────────────────────────────────────────
//   TODO: Move to presentation/report/MarkdownReportBuilder.ts
import { ReportBuilder } from "../report/ReportBuilder.js";

// ── Application: Use Cases ──────────────────────────────────────────────
import { RunCodeReview } from "../../application/RunCodeReview.js";
import { BootstrapProject } from "../../application/BootstrapProject.js";

// ── Core Interfaces (ports) ──────────────────────────────────────────────
import type { IFeedbackManager } from "../../application/RunCodeReview.js";
import type { IFileScanner } from "../../core/interfaces/IFileScanner.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";
import type { IProjectAuditor } from "../../core/interfaces/IProjectAuditor.js";
import type { IReportBuilder } from "../../core/interfaces/IReportBuilder.js";
import type { ISkillRepository } from "../../core/interfaces/ISkillRepository.js";

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: ProjectContext → ScannedProject
// ─────────────────────────────────────────────────────────────────────────────
// ProjectScanner.scan() returns ProjectContext with {packageJson: string|null}.
// IFileScanner.scan() must return {packageJson: string|undefined}.
// This inline adapter bridges the two without modifying the existing classes.

function projectContextToScannedProject(ctx: ProjectContext): ScannedProject {
  return {
    codeFiles: ctx.codeFiles,
    iacFiles: ctx.iacFiles,
    dependencyManifests: ctx.dependencyManifests,
    configFiles: ctx.configFiles,
    ciFiles: ctx.ciFiles,
    sampleSources: ctx.sampleSources,
    sampleTests: ctx.sampleTests,
    packageJson: ctx.packageJson ?? undefined,
    directoryTree: ctx.directoryTree,
    isPublicFacing: ctx.isPublicFacing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DependencyContainer
// ─────────────────────────────────────────────────────────────────────────────

export interface ContainerConfig {
  /** OAuth access token obtained by the authentication flow. */
  accessToken: string;
  /** Resolved Cloud AI Companion project ID. */
  cloudProject: string;
  /** Debug logger — no-op when debug mode is disabled. */
  logDebug: (msg: string) => void;
  /** False-positive suppression manager (loaded from baseDir by the CLI). */
  feedbackManager: IFeedbackManager;
}

/**
 * DependencyContainer
 *
 * Call `DependencyContainer.create(config)` at CLI startup (after auth).
 * The container owns the lifetime of all service instances.
 *
 * ```ts
 * const container = DependencyContainer.create({ accessToken, cloudProject, logDebug, feedbackManager });
 * const result = await container.runCodeReview.execute({ baseDir, logDebug });
 * ```
 */
export class DependencyContainer {
  // ── Publicly accessible use cases ─────────────────────────────────────────

  readonly runCodeReview: RunCodeReview;
  readonly bootstrapProject: BootstrapProject;

  // ── Internal services (accessible for testing) ────────────────────────────

  readonly aiProvider: IAiProvider;
  readonly fileScanner: IFileScanner;
  readonly auditors: IProjectAuditor[];
  readonly skillRepository: ISkillRepository;
  readonly reportBuilder: IReportBuilder;

  private constructor(config: ContainerConfig) {
    const { accessToken, cloudProject, logDebug, feedbackManager } = config;

    // ── Layer 1: Infrastructure — AI ─────────────────────────────────────────
    this.aiProvider = new GeminiProvider(accessToken, cloudProject, logDebug);

    // ── Layer 2: Infrastructure — Filesystem ──────────────────────────────────
    // ProjectScanner.scan() returns ProjectContext; a local adapter maps
    // null → undefined for packageJson to satisfy the IFileScanner contract.
    this.fileScanner = {
      scan: async (baseDir: string): Promise<ScannedProject> => {
        const ctx = await new ProjectScanner(baseDir).scan();
        return projectContextToScannedProject(ctx);
      },
    } satisfies IFileScanner;

    // ── Layer 3: Infrastructure — Config ──────────────────────────────────────
    this.skillRepository = new LocalSkillRepository();

    // ── Layer 4: Infrastructure — Auditor Pipeline (OCP) ─────────────────────
    //
    //   ┌─────────────────────────────────────────────────────────────────┐
    //   │  To add a new auditor: only change this array.                  │
    //   │  RunCodeReview.ts is never modified.                            │
    //   │                                                                 │
    //   │  Current pipeline:                                              │
    //   │    1. StaticSecurityAuditor  — local SAST, zero LLM cost       │
    //   │    2. InfraAuditorAdapter    — IaC/SCA via GeminiProvider      │
    //   │                                                                 │
    //   │  Example future auditor:                                        │
    //   │    3. new LicenseAuditor()   — checks SPDX in manifests        │
    //   └─────────────────────────────────────────────────────────────────┘
    this.auditors = [
      new StaticSecurityAuditor(),
      new InfraAuditorAdapter(this.aiProvider),
      // ← new LicenseAuditor() goes here when needed
    ];

    // ── Layer 5: Presentation — Report Builder ────────────────────────────────
    this.reportBuilder = new ReportBuilder();

    // ── Layer 6: Application — Use Cases ──────────────────────────────────────
    this.runCodeReview = new RunCodeReview(
      this.fileScanner,
      this.aiProvider,
      this.auditors,
      this.skillRepository,
      this.reportBuilder,
      feedbackManager,
    );

    this.bootstrapProject = new BootstrapProject(
      this.fileScanner,
      this.aiProvider,
      this.skillRepository,
    );
  }

  /**
   * Factory method — the recommended way to create the container.
   *
   * @param config  Runtime configuration (auth tokens, project, loggers).
   */
  static create(config: ContainerConfig): DependencyContainer {
    return new DependencyContainer(config);
  }
}
