// Copyright 2026 Google LLC

/**
 * RunCodeReview — the primary application Use Case.
 *
 * ## Responsibilities (one, per SRP)
 *   Orchestrate the code review pipeline by coordinating interfaces.
 *   No business logic lives here — only sequencing and error handling.
 *
 * ## Dependencies (all via interfaces — DIP)
 *   - IFileScanner      (provided by FastGlobScanner)
 *   - IAiProvider       (provided by GeminiProvider)
 *   - IProjectAuditor[] (pipeline — StaticSecurityAuditor, InfraAuditor, …)
 *   - ISkillRepository  (provided by LocalSkillRepository)
 *   - IReportBuilder    (provided by MarkdownReportBuilder)
 *   - IFeedbackManager  (provided by FeedbackManager — read-only)
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

import type {
  IAiProvider,
  CodeReviewBatch,
  ShallowReviewResult,
} from "../core/interfaces/IAiProvider.js";
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
  AiSubScores,
  TimingStats,
} from "../core/entities/ProjectReport.js";
import type { ReviewFinding } from "../core/entities/ReviewFinding.js";
import {
  NoSourceFilesError,
  AllBatchesFailedError,
} from "../core/domain-errors/ReviewerErrors.js";
import { CHUNK_CHAR_THRESHOLD } from "../shared/constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// IFeedbackManager — local interface (avoids importing infrastructure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only view of the false-positive suppression list.
 * The full FeedbackManager class lives in infrastructure; this port lets
 * RunCodeReview stay decoupled from filesystem I/O.
 */
export interface IFeedbackManager {
  readonly hasFeedback: boolean;
  buildSystemPromptSuffix(): string;
  isFalsePositive(file: string, line: number, snippet: string): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunCodeReview input/output
// ─────────────────────────────────────────────────────────────────────────────

export interface RunCodeReviewInput {
  /** Absolute path to the project root directory. */
  baseDir: string;
  /**
   * Pre-loaded scan result (e.g., shared from the auto-init flow).
   * When supplied, the file scanner is skipped.
   */
  preloadedProject?: ScannedProject;
  /** Whether to force a fresh authentication (ignore cached tokens). */
  forceLogin?: boolean;
  /** Logger for debug output. No-op when debug mode is off. */
  logDebug: (msg: string) => void;
  /** Progress spinner text updater (e.g. ora.text). No-op in non-interactive mode. */
  onProgress?: (message: string) => void;
}

export interface RunCodeReviewOutput {
  /** The assembled report ready for rendering. */
  report: ProjectReport;
  /** Path to the directory where files were written. */
  outputDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal cache shape
// ─────────────────────────────────────────────────────────────────────────────

interface CacheState {
  fileHashes: Record<string, string>;
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

/**
 * RunCodeReview
 *
 * Constructed via dependency injection in DependencyContainer.
 * Depends ONLY on core interfaces — no SDK or fs imports allowed here.
 */
export class RunCodeReview {
  constructor(
    private readonly scanner: IFileScanner,
    private readonly aiProvider: IAiProvider,
    /** OCP: iterate this pipeline without changing orchestration logic. */
    private readonly auditors: IProjectAuditor[],
    private readonly skillRepository: ISkillRepository,
    private readonly reportBuilder: IReportBuilder,
    private readonly feedbackManager: IFeedbackManager,
  ) {}

  // ── Public entry point ────────────────────────────────────────────────────

  async execute(input: RunCodeReviewInput): Promise<RunCodeReviewOutput> {
    const {
      baseDir,
      preloadedProject,
      logDebug,
      onProgress = () => {},
    } = input;

    const t0 = performance.now();

    // ── Step 1: Scan the project (or reuse pre-loaded context) ───────────────
    onProgress("Scanning project (code, IaC, configs)...");
    logDebug(`Scanning base directory: ${baseDir}`);

    const scanStart = performance.now();
    const project: ScannedProject = preloadedProject
      ? (logDebug(
          "Reusing pre-loaded ScannedProject (no second filesystem scan).",
        ),
        preloadedProject)
      : await this.scanner.scan(baseDir);

    const { codeFiles } = project;

    if (codeFiles.length === 0) {
      throw new NoSourceFilesError(`No source files found in ${baseDir}.`);
    }

    logDebug(`Scanned: ${codeFiles.length} source file(s).`);

    // ── Step 2: Create output directory ──────────────────────────────────────
    const outputDir = path.join(baseDir, "gemini-code-reviewer");
    await nodefs.mkdir(outputDir, { recursive: true });

    // ── Step 3: Load incremental review cache ────────────────────────────────
    const statePath = path.join(outputDir, ".gemini-code-reviewer.json");
    let previousState: CacheState | null = null;
    try {
      const rawState = await nodefs.readFile(statePath, "utf-8");
      previousState = JSON.parse(rawState) as CacheState;
    } catch {
      // No cache yet — full review
    }

    // ── Step 4: Detect changed files ─────────────────────────────────────────
    const currentFileHashes: Record<string, string> = {};
    const changedFiles = codeFiles.filter((f) => {
      const hash = crypto.createHash("sha256").update(f.content).digest("hex");
      currentFileHashes[f.filePath] = hash;
      const unchanged =
        previousState?.fileHashes &&
        previousState.fileHashes[f.filePath] === hash;
      return !unchanged;
    });

    const unchangedFilePaths = codeFiles
      .map((f) => f.filePath)
      .filter((p) => !changedFiles.find((cf) => cf.filePath === p));

    // Carry over findings for unchanged files from the cache
    const oldFindings: ReviewFinding[] = previousState?.findings
      ? (previousState.findings as ReviewFinding[]).filter((f) =>
          unchangedFilePaths.includes(f.file),
        )
      : [];

    // Fast-path: no changes since last review
    if (changedFiles.length === 0 && previousState) {
      logDebug("No file changes detected — returning cached report.");
      const cachedReport = this.buildReportFromCache(
        previousState,
        currentFileHashes,
      );
      return { report: cachedReport, outputDir };
    }

    logDebug(`Changed files: ${changedFiles.length}`);

    // ── Step 5: Load skills context ───────────────────────────────────────────
    onProgress("Loading skills context...");
    const skillsContext = await this.skillRepository.loadSkillsContext(baseDir);
    logDebug(`Skills context: ${skillsContext.length} chars.`);

    const feedbackSuffix = this.feedbackManager.buildSystemPromptSuffix();
    const scanMs = performance.now() - scanStart;

    // ── Step 6: Run the auditor pipeline (OCP) ───────────────────────────────
    const auditStart = performance.now();
    const auditContext: AuditContext = {
      codeFiles,
      iacFiles: project.iacFiles,
      dependencyManifests: project.dependencyManifests,
      isPublicFacing: project.isPublicFacing,
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
        combinedAuditResult = this.mergeAuditResults(
          combinedAuditResult,
          result,
        );
      } catch (e: any) {
        logDebug(`Auditor "${auditor.name}" failed: ${e.message}`);
        // Individual auditor failures are non-fatal; pipeline continues
      }
    }

    const secretFindings = combinedAuditResult.secretFindings ?? [];
    const infraFindings = combinedAuditResult.infraFindings ?? [];
    const infraScannedFiles = combinedAuditResult.scannedFiles ?? [];
    const isPublicFacing =
      combinedAuditResult.isPublicFacing ?? project.isPublicFacing;
    const auditMs = performance.now() - auditStart;

    // ── Step 7: Dual-mode AI review (sequential to respect rate limits) ────────
    //
    // Two sequential phases:
    //   A) Shallow oneshot — sends ALL code in one request for global metrics
    //      (code duplication, cyclomatic complexity, maintainability index).
    //      These scores require 100% codebase visibility.
    //
    //   B) Deep chunks — splits code into ~5k-token chunks and reviews each
    //      one sequentially for detailed findings + per-chunk naming/SOLID scores.
    //
    // All requests are sequential to avoid hitting API rate limits (429).
    // ─────────────────────────────────────────────────────────────────────────────

    const filesToReview = changedFiles.map((f) => ({
      filePath: f.filePath,
      content: f.content,
    }));

    // Build the full payload for the shallow oneshot scan
    const HEADER = "Review the following code:\n\n";
    const fullPayload =
      HEADER +
      filesToReview
        .map((f) => `<file path="${f.filePath}">\n${f.content}\n</file>\n\n`)
        .join("");

    // Build small chunks for deep review
    const deepChunks = this.buildBatches(filesToReview, CHUNK_CHAR_THRESHOLD);

    logDebug(
      `Dual-mode review: 1 shallow oneshot + ${deepChunks.length} deep chunk(s).`,
    );

    // ── Step 7A: Shallow oneshot (global metrics, runs first) ─────────────────
    const shallowStart = performance.now();
    let shallowResult: ShallowReviewResult | null = null;
    onProgress("[Oneshot] Global metrics scan...");
    try {
      shallowResult = await this.aiProvider.shallowReviewFull(fullPayload);
      logDebug(
        `Shallow oneshot complete: dup=${shallowResult.codeDuplicationPercentage}%, cc=${shallowResult.cyclomaticComplexity}, mi=${shallowResult.maintainabilityIndex}`,
      );
    } catch (err: any) {
      logDebug(`Shallow oneshot failed: ${err?.message ?? err}`);
    }
    const shallowReviewMs = performance.now() - shallowStart;

    // ── Step 7B: Deep chunk pipeline (detailed findings, one-by-one) ──────────
    const deepStart = performance.now();
    const allNewFindings: ReviewFinding[] = [];
    const chunkSubScores: AiSubScores[] = [];
    let chunksSucceeded = 0;

    for (let i = 0; i < deepChunks.length; i++) {
      const progress = Math.round(((i + 1) / deepChunks.length) * 100);
      onProgress(
        `[${progress}%] Deep review chunk ${i + 1}/${deepChunks.length}...`,
      );

      try {
        const result = await this.aiProvider.deepReviewChunk(deepChunks[i], {
          skillsContext,
          feedbackSuffix,
        });

        // Resolve accurate line numbers from original (non-minified) content
        for (const finding of result.findings) {
          const fileMatch = changedFiles.find(
            (f) => f.filePath === finding.file,
          );
          if (fileMatch && finding.snippet) {
            finding.line = this.resolveLineNumber(
              fileMatch.originalContent,
              finding.snippet,
            );
          }
        }

        allNewFindings.push(...result.findings);
        chunkSubScores.push(result.subScores);
        chunksSucceeded++;
      } catch (err: any) {
        logDebug(`Deep chunk ${i + 1} failed: ${err?.message ?? err}`);
      }
    }

    if (chunksSucceeded === 0 && deepChunks.length > 0) {
      throw new AllBatchesFailedError(
        "Gemini API call failed for all chunks. Check your authentication and network.",
      );
    }
    const deepReviewMs = performance.now() - deepStart;

    // ── Step 8: Annotate findings with risk multipliers ───────────────────────
    // (Risk multiplier is metadata for display; actual scoring is in ReportBuilder)
    for (const finding of allNewFindings) {
      finding.riskMultiplier = this.computeFileRisk(finding.file);
    }

    // Merge new findings with carried-over cached findings
    const allFindings: ReviewFinding[] = [...allNewFindings, ...oldFindings];

    // Filter confirmed false positives
    const filteredFindings = allFindings.filter(
      (f) =>
        !this.feedbackManager.isFalsePositive(f.file, f.line, f.snippet ?? ""),
    );

    // ── Step 9: Aggregate AI sub-scores (shallow + deep) ──────────────────────
    const aiSubScores = this.aggregateSubScores(
      chunkSubScores,
      shallowResult,
      previousState,
    );

    // ── Step 10: Generate executive summary ───────────────────────────────────
    const summaryStart = performance.now();
    onProgress("Generating Executive Summary...");

    // Prime the report builder to calculate the score for the summary prompt
    this.reportBuilder.addAiFindings(filteredFindings);
    this.reportBuilder.addSecretResults(secretFindings);
    this.reportBuilder.addInfrastructureResults({
      findings: infraFindings,
      isPublicFacing,
      scannedFiles: infraScannedFiles,
    });
    this.reportBuilder.setAiScores(aiSubScores);
    const previewScore = this.reportBuilder.calculateFinalScore();

    const executiveSummary = await this.aiProvider.generateExecutiveSummary({
      overallScore: previewScore,
      totalCodeFindings: filteredFindings.length,
      totalSecrets: secretFindings.length,
      totalInfraFindings: infraFindings.length,
      isPublicFacing,
      sampleFiles: codeFiles.slice(0, 10).map((f) => f.filePath),
      topHighFindings: filteredFindings
        .filter((f) => f.priority === "high")
        .slice(0, 10)
        .map(
          (f) => `- [${f.file}:${f.line}] ${f.suggestion?.slice(0, 120) ?? ""}`,
        ),
      topInfraFindings: infraFindings
        .filter((f) => f.severity === "critical" || f.severity === "high")
        .slice(0, 5)
        .map(
          (f) =>
            `- [${f.file}] ${f.title}: ${f.description?.slice(0, 100) ?? ""}`,
        ),
    });

    if (executiveSummary) {
      this.reportBuilder.setExecutiveSummary(executiveSummary);
    }

    const finalScore = this.reportBuilder.calculateFinalScore();
    const summaryMs = performance.now() - summaryStart;

    // ── Compute timing stats ─────────────────────────────────────────────────
    const totalMs = performance.now() - t0;
    const timingStats: TimingStats = {
      totalMs: Math.round(totalMs),
      scanMs: Math.round(scanMs),
      auditMs: Math.round(auditMs),
      shallowReviewMs: Math.round(shallowReviewMs),
      deepReviewMs: Math.round(deepReviewMs),
      summaryMs: Math.round(summaryMs),
      deepChunkCount: deepChunks.length,
      timestamp: new Date().toISOString(),
    };

    logDebug(
      `Timing: total=${(totalMs / 1000).toFixed(1)}s, scan=${(scanMs / 1000).toFixed(1)}s, audit=${(auditMs / 1000).toFixed(1)}s, ` +
        `shallow=${(shallowReviewMs / 1000).toFixed(1)}s, deep=${(deepReviewMs / 1000).toFixed(1)}s (${deepChunks.length} chunks), ` +
        `summary=${(summaryMs / 1000).toFixed(1)}s`,
    );

    this.reportBuilder.setTimingStats(timingStats);
    // ── Step 11: Persist the cache ────────────────────────────────────────────
    const cacheState: CacheState = {
      fileHashes: currentFileHashes,
      findings: filteredFindings,
      secretFindings,
      infraFindings,
      isPublicFacing,
      executiveSummary,
      namingConventionScore: aiSubScores.namingConventionScore,
      solidPrinciplesScore: aiSubScores.solidPrinciplesScore,
      codeDuplicationPercentage: aiSubScores.codeDuplicationPercentage,
      cyclomaticComplexity: aiSubScores.cyclomaticComplexity,
      maintainabilityIndex: aiSubScores.maintainabilityIndex,
      timingStats,
    };

    try {
      await nodefs.writeFile(
        statePath,
        JSON.stringify(cacheState, null, 2),
        "utf-8",
      );
    } catch (err: any) {
      logDebug(`Could not save cache to ${statePath}: ${err.message}`);
    }

    // ── Step 12: Assemble the final ProjectReport ─────────────────────────────
    const report: ProjectReport = {
      codeFindings: filteredFindings,
      secretFindings,
      infraFindings,
      isPublicFacing,
      infraScannedFiles,
      executiveSummary,
      aiSubScores,
      fileHashes: currentFileHashes,
      timingStats,
    };

    logDebug(`Review complete. Final score: ${finalScore}/100.`);
    return { report, outputDir };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildBatches(
    files: Array<{ filePath: string; content: string }>,
    charLimit: number = CHUNK_CHAR_THRESHOLD,
  ): CodeReviewBatch[] {
    const batches: CodeReviewBatch[] = [];
    const HEADER = "Review the following code:\n\n";
    let current = HEADER;
    let currentFiles: string[] = [];

    for (const f of files) {
      const fileXml = `<file path="${f.filePath}">\n${f.content}\n</file>\n\n`;
      if (current.length + fileXml.length > charLimit && current !== HEADER) {
        batches.push({ payload: current, files: currentFiles });
        current = HEADER + fileXml;
        currentFiles = [f.filePath];
      } else {
        current += fileXml;
        currentFiles.push(f.filePath);
      }
    }

    if (current !== HEADER) {
      batches.push({ payload: current, files: currentFiles });
    }

    return batches;
  }

  private mergeAuditResults(
    base: AuditResult,
    addition: AuditResult,
  ): AuditResult {
    return {
      codeFindings: [
        ...(base.codeFindings ?? []),
        ...(addition.codeFindings ?? []),
      ],
      secretFindings: [
        ...(base.secretFindings ?? []),
        ...(addition.secretFindings ?? []),
      ],
      infraFindings: [
        ...(base.infraFindings ?? []),
        ...(addition.infraFindings ?? []),
      ],
      scannedFiles: [
        ...(base.scannedFiles ?? []),
        ...(addition.scannedFiles ?? []),
      ],
      isPublicFacing: addition.isPublicFacing ?? base.isPublicFacing,
    };
  }

  private aggregateSubScores(
    chunkScores: AiSubScores[],
    shallowResult: ShallowReviewResult | null,
    previousState: CacheState | null,
  ): AiSubScores {
    // Deep chunk scores: average naming + SOLID across all chunks
    const n = chunkScores.length;
    let namingConventionScore: number | undefined;
    let solidPrinciplesScore: number | undefined;

    if (n > 0) {
      const sumNaming = chunkScores.reduce(
        (acc, s) => acc + ((s.namingConventionScore as number) ?? 0),
        0,
      );
      const sumSolid = chunkScores.reduce(
        (acc, s) => acc + ((s.solidPrinciplesScore as number) ?? 0),
        0,
      );
      namingConventionScore = Math.round(sumNaming / n);
      solidPrinciplesScore = Math.round(sumSolid / n);
    } else {
      namingConventionScore = previousState?.namingConventionScore;
      solidPrinciplesScore = previousState?.solidPrinciplesScore;
    }

    // Shallow result provides global metrics; fall back to cache if unavailable
    const codeDuplicationPercentage =
      shallowResult?.codeDuplicationPercentage ??
      previousState?.codeDuplicationPercentage ??
      0;
    const cyclomaticComplexity =
      shallowResult?.cyclomaticComplexity ??
      previousState?.cyclomaticComplexity ??
      0;
    const maintainabilityIndex =
      shallowResult?.maintainabilityIndex ??
      previousState?.maintainabilityIndex ??
      0;

    return {
      namingConventionScore,
      solidPrinciplesScore,
      codeDuplicationPercentage,
      cyclomaticComplexity,
      maintainabilityIndex,
    };
  }

  /**
   * Resolves the line number for a snippet using whitespace-normalised matching.
   * This pure function replaces the old `findLineNumberToMatchSnippet` call
   * in reviewer.ts.
   */
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
      for (let k = 0; k < stripped.length; k++) {
        indexToLine.push(j + 1);
      }
    }

    const matchIndex = normContent.indexOf(normSnippet);
    return matchIndex !== -1 ? (indexToLine[matchIndex] ?? 1) : 1;
  }

  /**
   * Simplified path-based risk multiplier.
   * The full implementation lives in security-scanner.ts (infrastructure).
   * This version keeps the use case self-contained for pure logic testing.
   */
  private computeFileRisk(filePath: string): number {
    const parts = filePath.replace(/\\/g, "/").toLowerCase().split("/");
    const PUBLIC_FACING = [
      "controller",
      "controllers",
      "route",
      "routes",
      "api",
      "endpoint",
      "handler",
      "resolver",
      "gateway",
    ];
    const BUSINESS = [
      "service",
      "services",
      "manager",
      "usecase",
      "domain",
      "repository",
    ];
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
      secretFindings: (state.secretFindings as any[]) ?? [],
      infraFindings: (state.infraFindings as any[]) ?? [],
      isPublicFacing: state.isPublicFacing ?? false,
      infraScannedFiles: [],
      executiveSummary: state.executiveSummary as any,
      aiSubScores: {
        namingConventionScore: state.namingConventionScore,
        solidPrinciplesScore: state.solidPrinciplesScore,
        codeDuplicationPercentage: state.codeDuplicationPercentage,
        cyclomaticComplexity: state.cyclomaticComplexity,
        maintainabilityIndex: state.maintainabilityIndex,
      },
      fileHashes: currentFileHashes,
    };
  }
}
