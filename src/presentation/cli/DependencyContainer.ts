// Copyright 2026 Google LLC

/**
 * DependencyContainer — the Composition Root for Clean Architecture.
 *
 * ## Changes
 *   - GeminiProvider now receives `outputDir` so AiCallLogger writes
 *     call logs to `<baseDir>/gemini-code-reviewer/ai-calls/` instead
 *     of CWD. outputDir is set in ContainerConfig and forwarded here.
 *   - CodeBenchmarkAuditor registered before InfraAuditorAdapter.
 */

import * as path from "node:path";

import { GeminiProvider } from "../../infrastructure/ai/GeminiProvider.js";
import { ProjectScanner } from "../../infrastructure/filesystem/ProjectScanner.js";
import type { ProjectContext } from "../../infrastructure/filesystem/ProjectScanner.js";
import type { ScannedProject } from "../../core/interfaces/IFileScanner.js";
import { StaticSecurityAuditor } from "../../infrastructure/security/StaticSecurityAuditor.js";
import { InfraAuditorAdapter } from "../../infrastructure/security/InfraAuditorAdapter.js";
import { CodeBenchmarkAuditor } from "../../infrastructure/benchmark/CodeBenchmarkAuditor.js";
import { LocalSkillRepository } from "../../infrastructure/config/LocalSkillRepository.js";
import { ReportBuilder } from "../report/ReportBuilder.js";
import { RunCodeReview } from "../../application/RunCodeReview.js";
import { BootstrapProject } from "../../application/BootstrapProject.js";
import type { IFeedbackManager } from "../../application/RunCodeReview.js";
import type { IFileScanner } from "../../core/interfaces/IFileScanner.js";
import type { IAiProvider } from "../../core/interfaces/IAiProvider.js";
import type { IProjectAuditor } from "../../core/interfaces/IProjectAuditor.js";
import type { IReportBuilder } from "../../core/interfaces/IReportBuilder.js";
import type { ISkillRepository } from "../../core/interfaces/ISkillRepository.js";

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: ProjectContext → ScannedProject
// ─────────────────────────────────────────────────────────────────────────────

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
// ContainerConfig
// ─────────────────────────────────────────────────────────────────────────────

export interface ContainerConfig {
  accessToken: string;
  cloudProject: string;
  logDebug: (msg: string) => void;
  feedbackManager: IFeedbackManager;
  /**
   * Base directory of the project being reviewed.
   * Used to construct the output dir for AI call logs:
   *   <baseDir>/gemini-code-reviewer/ai-calls/
   */
  baseDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DependencyContainer
// ─────────────────────────────────────────────────────────────────────────────

export class DependencyContainer {
  readonly runCodeReview: RunCodeReview;
  readonly bootstrapProject: BootstrapProject;
  readonly aiProvider: IAiProvider;
  readonly fileScanner: IFileScanner;
  readonly auditors: IProjectAuditor[];
  readonly skillRepository: ISkillRepository;
  readonly reportBuilder: IReportBuilder;

  private constructor(config: ContainerConfig) {
    const { accessToken, cloudProject, logDebug, feedbackManager, baseDir } = config;

    // AI call logs → <baseDir>/gemini-code-reviewer/ai-calls/
    const outputDir = path.join(baseDir, "gemini-code-reviewer");

    // Layer 1: AI
    this.aiProvider = new GeminiProvider(accessToken, cloudProject, logDebug, outputDir);

    // Layer 2: Filesystem
    this.fileScanner = {
      scan: async (dir: string): Promise<ScannedProject> => {
        const ctx = await new ProjectScanner(dir).scan();
        return projectContextToScannedProject(ctx);
      },
    } satisfies IFileScanner;

    // Layer 3: Config
    this.skillRepository = new LocalSkillRepository();

    // Layer 4: Auditor pipeline
    //
    //  ┌─────────────────────────────────────────────────────────────────────┐
    //  │  1. StaticSecurityAuditor   zero AI — regex SAST, ~0ms           │
    //  │  2. CodeBenchmarkAuditor    zero AI — CC / dup / naming, ~50ms   │
    //  │  3. InfraAuditorAdapter     AI Call 1: auditInfra                │
    //  │                            AI Call 2: deepReview                │
    //  └─────────────────────────────────────────────────────────────────────┘
    this.auditors = [
      new StaticSecurityAuditor(),
      new CodeBenchmarkAuditor(),
      new InfraAuditorAdapter(this.aiProvider),
    ];

    // Layer 5: Report Builder
    this.reportBuilder = new ReportBuilder();

    // Layer 6: Use Cases
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

  static create(config: ContainerConfig): DependencyContainer {
    return new DependencyContainer(config);
  }
}
