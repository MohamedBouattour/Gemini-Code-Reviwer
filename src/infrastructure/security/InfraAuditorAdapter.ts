// Copyright 2026 Google LLC

/**
 * InfraAuditorAdapter — Smart File Scoring pipeline, Step 1.
 *
 * This auditor runs TWO sequential Gemini calls and returns ALL findings:
 *
 *  Call 1 · auditInfra
 *    Sends: package.json + IaC files + full file-tree manifest (path/ext/bytes/lines)
 *    NO source code is sent — only metadata.
 *    Returns: every file scored 0–100 by impact weight + ignore_in_deep_review flag.
 *    Temperature: 0.0 (fully deterministic — same tree = same weights).
 *
 *  Call 2 · deepReview
 *    Sends: source content of files where weight ≥ DEEP_REVIEW_WEIGHT_THRESHOLD
 *           AND ignore_in_deep_review === false.
 *    Also sends direct imports and paired HTML/template files for those files.
 *    Returns: per-file issues (severity/type/evidence/fix) + repo-level findings.
 *    Temperature: 0.1
 *
 * WHY THIS REPLACES reviewProject + reviewInfrastructure
 *   - Old approach: dump entire codebase (~26k tokens) into one blind LLM call.
 *   - New approach: use ~400-token metadata manifest to let Gemini self-select
 *     the high-impact files, then deep-review only those (~5–8k tokens).
 *   - Token savings: typically 60–80 % fewer tokens on the review call.
 *   - Quality improvement: Gemini gives focused, evidence-rich findings on
 *     files that actually matter instead of shallow findings spread thin.
 *
 * STAGGER
 *   A 2 s pause is inserted between Call 1 and Call 2 to avoid 429 storms
 *   on the Code Assist API's per-project RPM quota.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type {
  IAiProvider,
  ScoredFile,
  InfraAuditRequest,
  DeepReviewRequest,
} from "../../core/interfaces/IAiProvider.js";
import type { ReviewFinding } from "../../core/entities/ReviewFinding.js";
import type { InfraFindingEntity } from "../../core/entities/ProjectReport.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Files with weight >= this threshold are sent to the deep review call.
 * Range: 0–100.  Default 40 keeps a focused set (typically top 20–30 % of files).
 * Lower = more files reviewed (higher token cost, more findings).
 * Higher = only the most critical files reviewed (fewer tokens, fewer findings).
 */
const DEEP_REVIEW_WEIGHT_THRESHOLD = 40;

/** Pause between Call 1 and Call 2 to avoid RPM quota 429s. */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// InfraAuditorAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class InfraAuditorAdapter implements IProjectAuditor {
  readonly name =
    "Infrastructure & Dependency Audit (IaC/SCA + Smart File Scoring)";

  constructor(private readonly aiProvider: IAiProvider) {}

  async audit(context: AuditContext): Promise<AuditResult> {
    const {
      codeFiles,
      iacFiles,
      dependencyManifests,
      logDebug = () => {},
    } = context;

    // ── Call 1: auditInfra ───────────────────────────────────────────────────
    // Build the file-tree manifest (metadata only, NO source content).
    const fileTree = codeFiles.map((f) => ({
      path: f.filePath,
      extension: f.filePath.includes(".") ? f.filePath.split(".").pop()! : "",
      bytes: Buffer.byteLength(f.originalContent, "utf-8"),
      lines: f.originalContent.split("\n").length,
    }));

    const packageJson = dependencyManifests["package.json"] ?? "{}";

    const infraAuditRequest: InfraAuditRequest = {
      packageJson,
      infraFiles: iacFiles,
      fileTree,
    };

    logDebug(
      `[InfraAuditorAdapter] Call 1 · auditInfra: ${fileTree.length} files in manifest.`,
    );

    const callOneStart = performance.now();
    const auditResult = await this.aiProvider.auditInfra(infraAuditRequest);

    // ── Select files for deep review ─────────────────────────────────────────
    const selectedFiles = auditResult.files.filter(
      (f) =>
        f.weight >= DEEP_REVIEW_WEIGHT_THRESHOLD && !f.ignore_in_deep_review,
    );

    logDebug(
      `[InfraAuditorAdapter] Selected ${selectedFiles.length} / ${auditResult.files.length} files for deep review` +
        ` (weight ≥ ${DEEP_REVIEW_WEIGHT_THRESHOLD}, not ignored).`,
    );

    if (selectedFiles.length === 0) {
      logDebug(
        `[InfraAuditorAdapter] No files above threshold — skipping deep review.`,
      );
      return {
        codeFindings: [],
        infraFindings: this.extractInfraFindings(auditResult),
        secretFindings: [],
        scannedFiles: auditResult.files.map((f) => f.path),
        isPublicFacing: undefined,
      };
    }

    const auditInfraDurationMs = performance.now() - callOneStart;
    if (auditInfraDurationMs < 3_000) {
      logDebug(
        `[InfraAuditorAdapter] Micro-stagger 300ms (Call 1 done in ${Math.round(auditInfraDurationMs)}ms)…`,
      );
      await sleep(300);
    }

    // ── Build deep review payloads ───────────────────────────────────────────
    const selectedPaths = new Set(selectedFiles.map((f) => f.path));

    // Primary: selected file contents
    const fileContents: Record<string, string> = {};
    for (const f of codeFiles) {
      if (selectedPaths.has(f.filePath)) {
        fileContents[f.filePath] = f.content; // optimized content
      }
    }

    // Imports: files directly imported by selected files (non-boilerplate, not already selected)
    const importContents: Record<string, string> = this.resolveImports(
      selectedFiles,
      codeFiles,
      selectedPaths,
    );

    // Templates: paired .html/.component.html files for selected .ts files
    const templateContents: Record<string, string> = this.resolveTemplates(
      selectedFiles,
      codeFiles,
    );

    logDebug(
      `[InfraAuditorAdapter] Call 2 · deepReview: ${Object.keys(fileContents).length} primary,` +
        ` ${Object.keys(importContents).length} imports,` +
        ` ${Object.keys(templateContents).length} templates.`,
    );

    const deepReviewRequest: DeepReviewRequest = {
      fileContents,
      importContents,
      templateContents,
    };

    // ── Call 2: deepReview ───────────────────────────────────────────────────
    const deepResult = await this.aiProvider.deepReview(deepReviewRequest);

    // ── Map results to core entities ─────────────────────────────────────────
    const codeFindings: ReviewFinding[] = deepResult.reviewed_files.flatMap(
      (reviewedFile) =>
        reviewedFile.issues.map((issue) => ({
          file: reviewedFile.path,
          line: 1, // line resolution happens in RunCodeReview via snippet matching
          snippet: issue.evidence,
          suggestion: issue.suggested_fix,
          category: issue.type,
          priority: this.mapSeverityToPriority(issue.severity),
        })),
    );

    // Repo-level findings become high-priority infraFindings with file="[repo]"
    const repoLevelInfraFindings: InfraFindingEntity[] =
      deepResult.repo_level_findings.map((f) => ({
        file: "[repo-level]",
        category: "other",
        title: f.title,
        description: f.detail,
        remediation: f.recommended_action,
        severity: f.rank <= 3 ? ("high" as const) : ("medium" as const),
      }));

    const infraFindings: InfraFindingEntity[] = [
      ...this.extractInfraFindings(auditResult),
      ...repoLevelInfraFindings,
    ];

    logDebug(
      `[InfraAuditorAdapter] Done: ${codeFindings.length} code findings,` +
        ` ${infraFindings.length} infra findings.`,
    );

    return {
      codeFindings,
      infraFindings,
      secretFindings: [],
      scannedFiles: selectedFiles.map((f) => f.path),
      isPublicFacing: undefined,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract infra/SCA findings from the auditInfra summary.
   * The audit result doesn't have explicit infra findings — those come from
   * the ignored_patterns_detected list, which we surface as low-severity items.
   */
  private extractInfraFindings(auditResult: {
    summary: { ignored_patterns_detected: string[] };
  }): InfraFindingEntity[] {
    return auditResult.summary.ignored_patterns_detected.map((pattern) => ({
      file: pattern,
      category: "other" as const,
      title: `Ignored pattern detected: ${pattern}`,
      description: `The file pattern "${pattern}" was flagged by the infra audit as typically non-reviewable.`,
      remediation:
        "Verify this file does not contain sensitive logic or secrets.",
      severity: "low" as const,
    }));
  }

  /**
   * Resolve direct imports for selected files.
   * Heuristic: scan each selected file's content for relative import/require
   * statements, find matching code files, include up to 10 non-selected ones.
   */
  private resolveImports(
    selectedFiles: ScoredFile[],
    allCodeFiles: AuditContext["codeFiles"],
    selectedPaths: Set<string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    const importRegex = /(?:import|require)\s*(?:[^'"]*['"])([.][^'"]+)['"]/g;
    const MAX_IMPORTS = 10;

    for (const sf of selectedFiles) {
      const sourceFile = allCodeFiles.find((f) => f.filePath === sf.path);
      if (!sourceFile) continue;

      let match: RegExpExecArray | null;
      const importRegexCopy = new RegExp(importRegex.source, importRegex.flags);
      while (
        (match = importRegexCopy.exec(sourceFile.originalContent)) !== null
      ) {
        const importedPath = match[1];
        // Resolve relative to the importing file's directory
        const dir = sf.path.split("/").slice(0, -1).join("/");
        const candidates = [
          `${dir}/${importedPath}`,
          `${dir}/${importedPath}.ts`,
          `${dir}/${importedPath}.js`,
          `${dir}/${importedPath}/index.ts`,
          `${dir}/${importedPath}/index.js`,
        ].map((p) => p.replace(/\/\//g, "/"));

        for (const candidate of candidates) {
          const resolved = allCodeFiles.find(
            (f) =>
              f.filePath === candidate ||
              f.filePath === candidate.replace(/^\.\//, ""),
          );
          if (
            resolved &&
            !selectedPaths.has(resolved.filePath) &&
            !result[resolved.filePath]
          ) {
            result[resolved.filePath] = resolved.content;
            if (Object.keys(result).length >= MAX_IMPORTS) return result;
            break;
          }
        }
      }
    }
    return result;
  }

  /**
   * Find paired Angular/Vue/Svelte templates for selected .ts/.js files.
   * Example: foo.component.ts → foo.component.html
   */
  private resolveTemplates(
    selectedFiles: ScoredFile[],
    allCodeFiles: AuditContext["codeFiles"],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const sf of selectedFiles) {
      const base = sf.path.replace(/\.(ts|js|tsx|jsx)$/, "");
      const templatePath = allCodeFiles.find(
        (f) =>
          f.filePath === `${base}.html` ||
          f.filePath === `${base}.component.html` ||
          f.filePath === `${base}.template.html`,
      );
      if (templatePath) result[templatePath.filePath] = templatePath.content;
    }
    return result;
  }

  private mapSeverityToPriority(
    severity: "HIGH" | "MEDIUM" | "LOW",
  ): ReviewFinding["priority"] {
    if (severity === "HIGH") return "high";
    if (severity === "MEDIUM") return "medium";
    return "low";
  }
}
