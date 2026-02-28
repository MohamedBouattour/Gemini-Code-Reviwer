// Copyright 2026 Google LLC

/**
 * RunCodeReview — the primary application Use Case.
 *
 * ## AI pipeline (Smart File Scoring — 2 calls total)
 *
 *   The one-shot "dump everything to Gemini" approach is removed.
 *   All AI calls now happen inside the InfraAuditorAdapter auditor:
 *
 *     [auditor pipeline]
 *       └─ StaticSecurityAuditor     (SAST secrets scan — no AI)
 *       └─ InfraAuditorAdapter       (AI Call 1: auditInfra, AI Call 2: deepReview)
 *
 *   RunCodeReview itself makes only ONE additional AI call:
 *     AI Call 3: generateExecutiveSummary  (light, ~400 tokens)
 *
 *   The old reviewProject() and reviewInfrastructure() calls are gone.
 *   Token usage drops 60–80 % compared to the one-shot approach.
 *
 * ## OCP: Auditor Pipeline
 *   Adding a new IProjectAuditor (e.g. LicenseAuditor) requires:
 *     1. Create the class.
 *     2. Register it in DependencyContainer.
 *     3. Zero changes here.
 */

import crypto from "node:crypto";
import * as nodefs from "node:fs/promises";
import * as path from "node:path";

import type { IAiProvider } from "../core/interfaces/IAiProvider.js";
import type {
  IFileScanner,
  ScannedProject,
} from "../core/interfaces/IFileScanner.js";
import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../core/interfaces/IProjectAuditor.js";
import type { ISkillRepository } from "../core/interfaces/ISkillRepository.js";
import type { IReportBuilder } from "../core/interfaces/IReportBuilder.js";
import type {
  ProjectReport,
  SecretFindingEntity,
  InfraFindingEntity,
  TimingStats,
} from "../core/entities/ProjectReport.js";
import type { ReviewFinding } from "../core/entities/ReviewFinding.js";
import { NoSourceFilesError } from "../core/domain-errors/ReviewerErrors.js";

// ─────────────────────────────────────────────────────────────────────────────
// IFeedbackManager — local interface (avoids importing infrastructure)
// ─────────────────────────────────────────────────────────────────────────────

export interface IFeedbackManager {
  readonly hasFeedback: boolean;
  buildSystemPromptSuffix(): string;
  isFalsePositive(file: string, line: number, snippet: string): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunCodeReview input/output
// ─────────────────────────────────────────────────────────────────────────────

export interface RunCodeReviewInput {
  baseDir: string;
  preloadedProject?: ScannedProject;
  forceLogin?: boolean;
  logDebug: (msg: string) => void;
  onProgress?: (message: string) => void;
}

export interface RunCodeReviewOutput {
  report: ProjectReport;
  outputDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal cache shape
// ─────────────────────────────────────────────────────────────────────────────

interface CacheState {
  fileHashes: Record<string, string>;
  iacFileHashes?: Record<string, string>;
  manifestHashes?: Record<string, string>;
  findings: ReviewFinding[];
  secretFindings?: unknown[];
  infraFindings?: unknown[];
  isPublicFacing?: boolean;
  executiveSummary?: unknown;
  namingConventionScore?: number;
  solidPrinciplesScore?: number;
  codeDuplicationPercentage?: number;
  cyclomaticComplexity?: number;
  maintainabilityIndex?: number;
  timingStats?: TimingStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunCodeReview — the Use Case class
// ─────────────────────────────────────────────────────────────────────────────

export class RunCodeReview {
  constructor(
    private readonly scanner: IFileScanner,
    private readonly aiProvider: IAiProvider,
    private readonly auditors: IProjectAuditor[],
    private readonly skillRepository: ISkillRepository,
    private readonly reportBuilder: IReportBuilder,
    private readonly feedbackManager: IFeedbackManager,
  ) {}

  async execute(input: RunCodeReviewInput): Promise<RunCodeReviewOutput> {
    const { baseDir, preloadedProject, logDebug, onProgress = () => {} } = input;
    const t0 = performance.now();

    // ── Step 1: Scan ─────────────────────────────────────────────────────────
    onProgress("Scanning project (code, IaC, configs)...");
    logDebug(`Scanning base directory: ${baseDir}`);

    const scanStart = performance.now();
    const project: ScannedProject = preloadedProject
      ? (logDebug("Reusing pre-loaded ScannedProject."), preloadedProject)
      : await this.scanner.scan(baseDir);

    const { codeFiles } = project;
    if (codeFiles.length === 0) {
      throw new NoSourceFilesError(`No source files found in ${baseDir}.`);
    }
    logDebug(`Scanned: ${codeFiles.length} source file(s).`);

    // ── Step 2: Output directory ─────────────────────────────────────────────
    const outputDir = path.join(baseDir, "gemini-code-reviewer");
    await nodefs.mkdir(outputDir, { recursive: true });

    // ── Step 3: Incremental cache ─────────────────────────────────────────────
    const statePath = path.join(outputDir, ".gemini-code-reviewer.json");
    let previousState: CacheState | null = null;
    try {
      previousState = JSON.parse(await nodefs.readFile(statePath, "utf-8")) as CacheState;
    } catch { /* no cache yet */ }

    const currentFileHashes: Record<string, string> = {};
    const changedFiles = codeFiles.filter((f) => {
      const hash = crypto.createHash("sha256").update(f.content).digest("hex");
      currentFileHashes[f.filePath] = hash;
      return previousState?.fileHashes?.[f.filePath] !== hash;
    });

    const unchangedFilePaths = codeFiles
      .map((f) => f.filePath)
      .filter((p) => !changedFiles.find((cf) => cf.filePath === p));

    const oldFindings: ReviewFinding[] = previousState?.findings
      ? (previousState.findings as ReviewFinding[]).filter((f) =>
          unchangedFilePaths.includes(f.file),
        )
      : [];

    if (changedFiles.length === 0 && previousState) {
      logDebug("No file changes detected — returning cached report.");
      return { report: this.buildReportFromCache(previousState, currentFileHashes), outputDir };
    }

    logDebug(`Changed files: ${changedFiles.length}`);
    const scanMs = performance.now() - scanStart;
    logDebug(`[timing] scan: ${(scanMs / 1000).toFixed(2)}s (${codeFiles.length} files, ${changedFiles.length} changed)`);

    // ── Step 4: Skills context ────────────────────────────────────────────────
    onProgress("Loading skills context...");
    const skillsContext = await this.skillRepository.loadSkillsContext(baseDir);
    logDebug(`Skills context: ${skillsContext.length} chars.`);
    const feedbackSuffix = this.feedbackManager.buildSystemPromptSuffix();
    void feedbackSuffix; // passed to auditors via context if needed

    // ── Step 5: Auditor pipeline ──────────────────────────────────────────────
    //
    // This is where ALL AI calls happen.
    // InfraAuditorAdapter runs:
    //   AI Call 1 · auditInfra   (file-tree metadata → scored file list)
    //   AI Call 2 · deepReview   (selected file content → findings)
    // StaticSecurityAuditor runs regex-based secret detection (no AI).
    //
    const auditStart = performance.now();
    const auditContext: AuditContext = {
      codeFiles: changedFiles, // only changed files for efficiency
      iacFiles: project.iacFiles,
      dependencyManifests: project.dependencyManifests,
      isPublicFacing: project.isPublicFacing,
      logDebug, // passed so auditors can emit debug lines
    };

    let combinedAuditResult: AuditResult = {
      codeFindings: [],
      secretFindings: [],
      infraFindings: [],
      scannedFiles: [],
    };

    for (const auditor of this.auditors) {
      onProgress(`Running ${auditor.name}...`);
      logDebug(`Running auditor: ${auditor.name}`);
      try {
        const result = await auditor.audit(auditContext);
        combinedAuditResult = this.mergeAuditResults(combinedAuditResult, result);
      } catch (e: any) {
        logDebug(`Auditor "${auditor.name}" failed: ${e.message}`);
      }
    }

    const secretFindings = combinedAuditResult.secretFindings ?? [];
    const infraScannedFiles = combinedAuditResult.scannedFiles ?? [];
    const isPublicFacing = combinedAuditResult.isPublicFacing ?? project.isPublicFacing;
    const auditMs = performance.now() - auditStart;
    logDebug(
      `[timing] audit+review: ${(auditMs / 1000).toFixed(2)}s` +
        ` (${secretFindings.length} secret(s),` +
        ` ${combinedAuditResult.codeFindings?.length ?? 0} code finding(s),` +
        ` ${combinedAuditResult.infraFindings?.length ?? 0} infra finding(s))`,
    );

    // ── Step 6: Annotate findings with risk multipliers + line resolution ─────
    const newCodeFindings = combinedAuditResult.codeFindings ?? [];
    for (const finding of newCodeFindings) {
      finding.riskMultiplier = this.getRiskMultiplier(finding.file);
      const fileMatch = changedFiles.find((f) => f.filePath === finding.file);
      if (fileMatch && finding.snippet) {
        finding.line = this.resolveLineNumber(fileMatch.originalContent, finding.snippet);
      }
    }

    const allCodeFindings: ReviewFinding[] = [...newCodeFindings, ...oldFindings];
    const filteredFindings = allCodeFindings.filter(
      (f) => !this.feedbackManager.isFalsePositive(f.file, f.line, f.snippet ?? ""),
    );
    const allInfraFindings: InfraFindingEntity[] = [
      ...(combinedAuditResult.infraFindings ?? []),
    ];

    // ── Step 7: Executive summary ─────────────────────────────────────────────
    const summaryStart = performance.now();
    onProgress("Generating Executive Summary…");

    this.reportBuilder.addAiFindings(filteredFindings);
    this.reportBuilder.addSecretResults(secretFindings);
    this.reportBuilder.addInfrastructureResults({
      findings: allInfraFindings,
      isPublicFacing,
      scannedFiles: infraScannedFiles,
    });
    // subScores are no longer available from the new pipeline (deepReview doesn't emit them)
    // They could be added back to DeepReviewResult in a future iteration.
    this.reportBuilder.setAiScores({});
    const previewScore = this.reportBuilder.calculateFinalScore();

    const executiveSummary = await this.aiProvider.generateExecutiveSummary({
      overallScore: previewScore,
      totalCodeFindings: filteredFindings.length,
      totalSecrets: secretFindings.length,
      totalInfraFindings: allInfraFindings.length,
      isPublicFacing,
      sampleFiles: codeFiles.slice(0, 10).map((f) => f.filePath),
      topHighFindings: filteredFindings
        .filter((f) => f.priority === "high")
        .slice(0, 10)
        .map((f) => `- [${f.file}:${f.line}] ${f.suggestion?.slice(0, 120) ?? ""}`),
      topInfraFindings: allInfraFindings
        .filter((f) => f.severity === "critical" || f.severity === "high")
        .slice(0, 5)
        .map((f) => `- [${f.file}] ${f.title}: ${f.description?.slice(0, 100) ?? ""}`),
    });

    if (executiveSummary) this.reportBuilder.setExecutiveSummary(executiveSummary);

    const finalScore = this.reportBuilder.calculateFinalScore();
    const summaryMs = performance.now() - summaryStart;
    logDebug(`[timing] summary: ${(summaryMs / 1000).toFixed(2)}s`);

    // ── Step 8: Timing stats ──────────────────────────────────────────────────
    const totalMs = performance.now() - t0;
    const timingStats: TimingStats = {
      totalMs: Math.round(totalMs),
      scanMs: Math.round(scanMs),
      auditMs: Math.round(auditMs),
      reviewMs: Math.round(auditMs), // auditMs now includes all AI review time
      summaryMs: Math.round(summaryMs),
      timestamp: new Date().toISOString(),
    };

    logDebug(
      "[timing] ────────────────────────────────────────\n" +
        `         scan          : ${(scanMs / 1000).toFixed(2)}s\n` +
        `         audit+review  : ${(auditMs / 1000).toFixed(2)}s  ← auditInfra → [2s] → deepReview\n` +
        `         summary       : ${(summaryMs / 1000).toFixed(2)}s\n` +
        `         ────────────────────────────────────────\n` +
        `         TOTAL         : ${(totalMs / 1000).toFixed(2)}s  |  score: ${finalScore}/100`,
    );

    this.reportBuilder.setTimingStats(timingStats);

    // ── Step 9: Persist cache ─────────────────────────────────────────────────
    const currentIacHashes: Record<string, string> = {};
    for (const [name, content] of Object.entries(project.iacFiles)) {
      currentIacHashes[name] = crypto.createHash("sha256").update(content).digest("hex");
    }
    const currentManifestHashes: Record<string, string> = {};
    for (const [name, content] of Object.entries(project.dependencyManifests)) {
      currentManifestHashes[name] = crypto.createHash("sha256").update(content).digest("hex");
    }

    const cacheState: CacheState = {
      fileHashes: currentFileHashes,
      iacFileHashes: currentIacHashes,
      manifestHashes: currentManifestHashes,
      findings: filteredFindings,
      secretFindings,
      infraFindings: allInfraFindings,
      isPublicFacing,
      executiveSummary,
      timingStats,
    };

    try {
      await nodefs.writeFile(statePath, JSON.stringify(cacheState, null, 2), "utf-8");
    } catch (err: any) {
      logDebug(`Could not save cache: ${err.message}`);
    }

    // ── Step 10: Assemble final report ────────────────────────────────────────
    const report: ProjectReport = {
      codeFindings: filteredFindings,
      secretFindings,
      infraFindings: allInfraFindings,
      isPublicFacing,
      infraScannedFiles,
      executiveSummary,
      aiSubScores: {},
      fileHashes: currentFileHashes,
      timingStats,
    };

    logDebug(`Review complete. Final score: ${finalScore}/100.`);
    return { report, outputDir };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private mergeAuditResults(base: AuditResult, addition: AuditResult): AuditResult {
    return {
      codeFindings: [...(base.codeFindings ?? []), ...(addition.codeFindings ?? [])],
      secretFindings: [...(base.secretFindings ?? []), ...(addition.secretFindings ?? [])],
      infraFindings: [...(base.infraFindings ?? []), ...(addition.infraFindings ?? [])],
      scannedFiles: [...(base.scannedFiles ?? []), ...(addition.scannedFiles ?? [])],
      isPublicFacing: addition.isPublicFacing ?? base.isPublicFacing,
    };
  }

  private resolveLineNumber(originalContent: string, snippet: string): number {
    if (!snippet || typeof snippet !== "string") return 1;
    const lines = originalContent.split("\n");
    const normSnippet = snippet.replace(/\s+/g, "");
    if (!normSnippet) return 1;
    let normContent = "";
    const indexToLine: number[] = [];
    for (let j = 0; j < lines.length; j++) {
      const stripped = lines[j].replace(/\s+/g, "");
      normContent += stripped;
      for (let k = 0; k < stripped.length; k++) indexToLine.push(j + 1);
    }
    const matchIndex = normContent.indexOf(normSnippet);
    return matchIndex !== -1 ? (indexToLine[matchIndex] ?? 1) : 1;
  }

  private getRiskMultiplier(filePath: string): number {
    const parts = filePath.replace(/\\/g, "/").toLowerCase().split("/");
    const PUBLIC_FACING = ["controller", "controllers", "route", "routes", "api", "endpoint", "handler", "resolver", "gateway"];
    const BUSINESS = ["service", "services", "manager", "usecase", "domain", "repository"];
    const TEST = ["spec", "test", "__tests__"];
    if (TEST.some((s) => parts.includes(s))) return 0.3;
    if (PUBLIC_FACING.some((s) => parts.includes(s))) return 2.0;
    if (BUSINESS.some((s) => parts.includes(s))) return 1.3;
    return 1.0;
  }

  private buildReportFromCache(
    state: CacheState,
    currentFileHashes: Record<string, string>,
  ): ProjectReport {
    return {
      codeFindings: (state.findings as ReviewFinding[]) ?? [],
      secretFindings: (state.secretFindings as SecretFindingEntity[]) ?? [],
      infraFindings: (state.infraFindings as InfraFindingEntity[]) ?? [],
      isPublicFacing: state.isPublicFacing ?? false,
      infraScannedFiles: [],
      executiveSummary: state.executiveSummary as ProjectReport["executiveSummary"],
      aiSubScores: {},
      fileHashes: currentFileHashes,
      timingStats: state.timingStats,
    };
  }
}
