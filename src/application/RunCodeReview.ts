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
 *   - IProjectAuditor[] (pipeline — StaticSecurityAuditor, …)
 *   - ISkillRepository  (provided by LocalSkillRepository)
 *   - IReportBuilder    (provided by MarkdownReportBuilder)
 *   - IFeedbackManager  (provided by FeedbackManager — read-only)
 *
 * ## AI call sequencing strategy
 *   The Code Assist API enforces a per-project RPM quota.
 *   Firing two large `generateContent` requests simultaneously causes both to
 *   hit 429 and each triggers its own 15–60 s backoff — effectively doubling
 *   wait time.
 *
 *   Strategy: run the heavier code-review call first, then immediately start
 *   the lighter infra call. A configurable INTER_CALL_STAGGER_MS delay is
 *   inserted between them to let the API quota window recover slightly.
 *   The net wall-clock time is virtually identical to the old parallel approach
 *   (infra call is tiny, ~800 tokens) but 429 storms are eliminated.
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
  ProjectReviewRequest,
  InfraReviewRequest,
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
  SecretFindingEntity,
  InfraFindingEntity,
  TimingStats,
} from "../core/entities/ProjectReport.js";
import type { ReviewFinding } from "../core/entities/ReviewFinding.js";
import { NoSourceFilesError } from "../core/domain-errors/ReviewerErrors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum gap (ms) between the end of one `generateContent` call and the
 * start of the next.
 *
 * Why 2 000 ms:
 *   - Code Assist uses a 60-second rolling RPM window.
 *   - 2 s is enough for the server-side quota counter to record the previous
 *     request before we issue the next one, without meaningfully slowing the
 *     CLI (the infra call itself takes ~2–4 s).
 *   - Set to 0 to disable (e.g., in unit tests).
 */
const INTER_CALL_STAGGER_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // ── Public entry point ────────────────────────────────────────────────

  async execute(input: RunCodeReviewInput): Promise<RunCodeReviewOutput> {
    const {
      baseDir,
      preloadedProject,
      logDebug,
      onProgress = () => {},
    } = input;

    const t0 = performance.now();

    // ── Step 1: Scan ───────────────────────────────────────────────────────────────
    onProgress("Scanning project (code, IaC, configs)...");
    logDebug(`Scanning base directory: ${baseDir}`);

    const scanStart = performance.now();
    const project: ScannedProject = preloadedProject
      ? (logDebug("Reusing pre-loaded ScannedProject (no second filesystem scan)."), preloadedProject)
      : await this.scanner.scan(baseDir);

    const { codeFiles } = project;
    if (codeFiles.length === 0) {
      throw new NoSourceFilesError(`No source files found in ${baseDir}.`);
    }
    logDebug(`Scanned: ${codeFiles.length} source file(s).`);

    // ── Step 2: Output directory ───────────────────────────────────────────────
    const outputDir = path.join(baseDir, "gemini-code-reviewer");
    await nodefs.mkdir(outputDir, { recursive: true });

    // ── Step 3: Incremental cache ──────────────────────────────────────────────
    const statePath = path.join(outputDir, ".gemini-code-reviewer.json");
    let previousState: CacheState | null = null;
    try {
      const rawState = await nodefs.readFile(statePath, "utf-8");
      previousState = JSON.parse(rawState) as CacheState;
    } catch {
      // No cache yet — full review
    }

    const currentFileHashes: Record<string, string> = {};
    const changedFiles = codeFiles.filter((f) => {
      const hash = crypto.createHash("sha256").update(f.content).digest("hex");
      currentFileHashes[f.filePath] = hash;
      const unchanged = previousState?.fileHashes?.[f.filePath] === hash;
      return !unchanged;
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

    // ── Step 4: Skills context ──────────────────────────────────────────────
    onProgress("Loading skills context...");
    const skillsContext = await this.skillRepository.loadSkillsContext(baseDir);
    logDebug(`Skills context: ${skillsContext.length} chars.`);
    const feedbackSuffix = this.feedbackManager.buildSystemPromptSuffix();

    // ── Step 5: Auditor pipeline ─────────────────────────────────────────────
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
        combinedAuditResult = this.mergeAuditResults(combinedAuditResult, result);
      } catch (e: any) {
        logDebug(`Auditor "${auditor.name}" failed: ${e.message}`);
      }
    }

    const secretFindings = combinedAuditResult.secretFindings ?? [];
    const infraScannedFiles = combinedAuditResult.scannedFiles ?? [];
    const isPublicFacing = combinedAuditResult.isPublicFacing ?? project.isPublicFacing;
    const auditMs = performance.now() - auditStart;
    logDebug(`[timing] audit: ${(auditMs / 1000).toFixed(2)}s (${secretFindings.length} secret(s) detected)`);

    // ── Step 6: AI Review — sequential with inter-call stagger ────────────────
    //
    // WHY SEQUENTIAL (not Promise.all):
    //   The Code Assist API enforces a per-project RPM (requests-per-minute)
    //   quota. Firing both calls at t=0 means both arrive at the server in the
    //   same quota window and one (or both) immediately receives a 429.
    //   Each call then independently retries after its own backoff window
    //   (15–60 s), which can double the total wait time.
    //
    //   Sequential guarantees only one in-flight request at a time.
    //   The infra call is ~800 tokens (vs ~26 000 for code review), so it
    //   completes in 2–3 s — the total wall-clock cost of sequencing is
    //   negligible compared to a single 15 s 429 backoff.
    //
    //   The INTER_CALL_STAGGER_MS pause after the first call gives the
    //   server-side quota window time to register the first request's
    //   token consumption before the second call arrives.
    // ────────────────────────────────────────────────────────────────────

    const reviewStart = performance.now();

    // — Prepare code review payload —
    const codePayload = changedFiles
      .map((f) => `<file path="${f.filePath}">\n${f.content}\n</file>`)
      .join("\n\n");

    const codeReviewRequest: ProjectReviewRequest = {
      codePayload,
      skillsContext,
      feedbackSuffix,
    };

    // — Prepare infra audit payload —
    const currentIacHashes: Record<string, string> = {};
    const changedIacFiles: Record<string, string> = {};
    for (const [name, content] of Object.entries(project.iacFiles)) {
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      currentIacHashes[name] = hash;
      if (previousState?.iacFileHashes?.[name] !== hash) changedIacFiles[name] = content;
    }

    const currentManifestHashes: Record<string, string> = {};
    const changedManifests: Record<string, string> = {};
    for (const [name, content] of Object.entries(project.dependencyManifests)) {
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      currentManifestHashes[name] = hash;
      if (previousState?.manifestHashes?.[name] !== hash) changedManifests[name] = content;
    }

    const projectTree = codeFiles.map((f) => f.filePath).join("\n");
    const infraReviewRequest: InfraReviewRequest = {
      iacFiles: changedIacFiles,
      dependencyManifests: changedManifests,
      projectTree,
    };

    logDebug(
      `reviewProject: ${changedFiles.length} code file(s) → ~${Math.ceil(codePayload.length / 4)} tokens`,
    );
    logDebug(
      `reviewInfrastructure: ${Object.keys(changedIacFiles).length} IaC` +
        ` + ${Object.keys(changedManifests).length} manifest(s)` +
        ` → ~${Math.ceil((JSON.stringify(changedIacFiles).length + JSON.stringify(changedManifests).length + projectTree.length) / 4)} tokens`,
    );

    // — Call 1: Code Review (heavier, ~26k tokens) —
    onProgress("Reviewing code with Gemini 2.5 Flash…");
    const codeReviewResult = await this.aiProvider.reviewProject(codeReviewRequest);
    logDebug(
      `reviewProject complete: ${codeReviewResult.codeFindings.length} finding(s).` +
        ` Staggering ${INTER_CALL_STAGGER_MS}ms before infra call…`,
    );

    // — Stagger pause: let the quota window register the first request —
    if (INTER_CALL_STAGGER_MS > 0) await sleep(INTER_CALL_STAGGER_MS);

    // — Call 2: Infra review (lighter, ~800 tokens) —
    onProgress("Auditing infrastructure & dependencies…");
    const infraReviewResult = await this.aiProvider.reviewInfrastructure(infraReviewRequest);

    const reviewMs = performance.now() - reviewStart;
    onProgress(
      `Review complete — ${codeReviewResult.codeFindings.length} code finding(s),` +
        ` ${infraReviewResult.infraFindings.length} infra finding(s).`,
    );
    logDebug(
      `[timing] review (sequential): ${(reviewMs / 1000).toFixed(2)}s` +
        ` → ${codeReviewResult.codeFindings.length} code finding(s),` +
        ` ${infraReviewResult.infraFindings.length} infra finding(s)` +
        ` | SOLID=${codeReviewResult.subScores.solidPrinciplesScore ?? "—"}` +
        ` naming=${codeReviewResult.subScores.namingConventionScore ?? "—"}` +
        ` MI=${codeReviewResult.subScores.maintainabilityIndex ?? "—"}` +
        ` CC=${codeReviewResult.subScores.cyclomaticComplexity ?? "—"}` +
        ` dup=${codeReviewResult.subScores.codeDuplicationPercentage ?? "—"}%`,
    );

    const reviewResult = {
      codeFindings: codeReviewResult.codeFindings,
      infraFindings: infraReviewResult.infraFindings,
      subScores: codeReviewResult.subScores,
    };

    // ── Step 7: Annotate findings ─────────────────────────────────────────────
    for (const finding of reviewResult.codeFindings) {
      finding.riskMultiplier = this.getRiskMultiplier(finding.file);
      const fileMatch = changedFiles.find((f) => f.filePath === finding.file);
      if (fileMatch && finding.snippet) {
        finding.line = this.resolveLineNumber(fileMatch.originalContent, finding.snippet);
      }
    }

    const allCodeFindings: ReviewFinding[] = [...reviewResult.codeFindings, ...oldFindings];
    const filteredFindings = allCodeFindings.filter(
      (f) => !this.feedbackManager.isFalsePositive(f.file, f.line, f.snippet ?? ""),
    );
    const allInfraFindings = [
      ...reviewResult.infraFindings,
      ...(combinedAuditResult.infraFindings ?? []),
    ];

    // ── Step 8: Executive summary ───────────────────────────────────────────
    const summaryStart = performance.now();
    onProgress("Generating Executive Summary…");

    this.reportBuilder.addAiFindings(filteredFindings);
    this.reportBuilder.addSecretResults(secretFindings);
    this.reportBuilder.addInfrastructureResults({
      findings: allInfraFindings,
      isPublicFacing,
      scannedFiles: infraScannedFiles,
    });
    this.reportBuilder.setAiScores(reviewResult.subScores);
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

    // ── Step 9: Timing stats ────────────────────────────────────────────────
    const totalMs = performance.now() - t0;
    const timingStats: TimingStats = {
      totalMs: Math.round(totalMs),
      scanMs: Math.round(scanMs),
      auditMs: Math.round(auditMs),
      reviewMs: Math.round(reviewMs),
      summaryMs: Math.round(summaryMs),
      timestamp: new Date().toISOString(),
    };

    logDebug(
      "[timing] ────────────────────────────────────────────────\n" +
        `         scan    : ${(scanMs / 1000).toFixed(2)}s\n` +
        `         audit   : ${(auditMs / 1000).toFixed(2)}s\n` +
        `         review  : ${(reviewMs / 1000).toFixed(2)}s  ← code → [${INTER_CALL_STAGGER_MS}ms stagger] → infra\n` +
        `         summary : ${(summaryMs / 1000).toFixed(2)}s\n` +
        `         ────────────────────────────────────────────────\n` +
        `         TOTAL   : ${(totalMs / 1000).toFixed(2)}s  |  score: ${finalScore}/100`,
    );

    this.reportBuilder.setTimingStats(timingStats);

    // ── Step 10: Persist cache ──────────────────────────────────────────────
    const cacheState: CacheState = {
      fileHashes: currentFileHashes,
      iacFileHashes: currentIacHashes,
      manifestHashes: currentManifestHashes,
      findings: filteredFindings,
      secretFindings,
      infraFindings: allInfraFindings,
      isPublicFacing,
      executiveSummary,
      namingConventionScore: reviewResult.subScores.namingConventionScore,
      solidPrinciplesScore: reviewResult.subScores.solidPrinciplesScore,
      codeDuplicationPercentage: reviewResult.subScores.codeDuplicationPercentage,
      cyclomaticComplexity: reviewResult.subScores.cyclomaticComplexity,
      maintainabilityIndex: reviewResult.subScores.maintainabilityIndex,
      timingStats,
    };

    try {
      await nodefs.writeFile(statePath, JSON.stringify(cacheState, null, 2), "utf-8");
    } catch (err: any) {
      logDebug(`Could not save cache to ${statePath}: ${err.message}`);
    }

    // ── Step 11: Assemble final report ─────────────────────────────────────────
    const report: ProjectReport = {
      codeFindings: filteredFindings,
      secretFindings,
      infraFindings: allInfraFindings,
      isPublicFacing,
      infraScannedFiles,
      executiveSummary,
      aiSubScores: reviewResult.subScores,
      fileHashes: currentFileHashes,
      timingStats,
    };

    logDebug(`Review complete. Final score: ${finalScore}/100.`);
    return { report, outputDir };
  }

  // ── Private helpers ────────────────────────────────────────────────

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
      aiSubScores: {
        namingConventionScore: state.namingConventionScore,
        solidPrinciplesScore: state.solidPrinciplesScore,
        codeDuplicationPercentage: state.codeDuplicationPercentage,
        cyclomaticComplexity: state.cyclomaticComplexity,
        maintainabilityIndex: state.maintainabilityIndex,
      },
      fileHashes: currentFileHashes,
      timingStats: state.timingStats,
    };
  }
}
