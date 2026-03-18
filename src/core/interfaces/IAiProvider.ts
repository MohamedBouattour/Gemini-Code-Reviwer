// Copyright 2026 Google LLC

/**
 * IAiProvider — the port the AI infrastructure must implement.
 *
 * Lives in the Core layer. Zero imports from infrastructure.
 * Enables Dependency Inversion: RunCodeReview depends on this interface,
 * not on GeminiProvider or @google/genai directly.
 *
 * Adding a ClaudeProvider or a MockProvider requires zero changes to the
 * application layer.
 */

import type { ReviewFinding } from "../entities/ReviewFinding.js";
import type {
  ExecutiveSummary,
  AiSubScores,
  InfraFindingEntity,
} from "../entities/ProjectReport.js";

// ─────────────────────────────────────────────────────────────────────────────
// Input shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The project payload for a code-focussed review.
 */
export interface ProjectReviewRequest {
  /** Combined XML-tagged code payload for all changed source files. */
  codePayload: string;
  /** Optional skills context injected into the system prompt. */
  skillsContext?: string;
  /** Optional false-positive suppression suffix for the system prompt. */
  feedbackSuffix?: string;
}

/**
 * The project payload for an infrastructure/SCA-focussed review.
 */
export interface InfraReviewRequest {
  /** IaC files: map of relative-path → content. */
  iacFiles: Record<string, string>;
  /** Dependency manifests: map of relative-path → content. */
  dependencyManifests: Record<string, string>;
  /** A text representation of the project file tree (without contents). */
  projectTree: string;
}

/**
 * The result of a code-focussed review call.
 */
export interface ProjectReviewResult {
  /** AI-generated code findings. */
  codeFindings: ReviewFinding[];
  /** Sub-scores for display in the report. */
  subScores: AiSubScores;
}

/**
 * The result of an infrastructure/SCA-focussed review call.
 */
export interface InfraReviewResult {
  /** AI-generated infra and SCA findings. */
  infraFindings: InfraFindingEntity[];
}

/** Context needed by the AI to understand how to score the summary. */
export interface ExecutiveSummaryInput {
  overallScore: number;
  totalCodeFindings: number;
  totalSecrets: number;
  totalInfraFindings: number;
  isPublicFacing: boolean;
  /** Up to 10 sample file paths (for "what does this do" context). */
  sampleFiles: string[];
  /** Up to 10 top HIGH findings (serialised as bullet strings). */
  topHighFindings: string[];
  /** Up to 5 top infra findings (serialised as bullet strings). */
  topInfraFindings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart File Scoring — input / output shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-file metadata sent to the infra audit call (Call 1).
 * The provider assembles the full tree list from these.
 */
export interface FileMetadata {
  /** Relative path from project root, e.g. "src/app/app.module.ts" */
  path: string;
  extension: string;
  /** File size in bytes. */
  bytes: number;
  /** Total number of lines. */
  lines: number;
}

/**
 * Per-file scoring result returned by Call 1 (infra audit).
 */
export interface ScoredFile extends FileMetadata {
  /** Impact weight 0–100. Higher = more relevant to deep review. */
  weight: number;
  /** Short human-readable rationale for the assigned weight. */
  reason: string;
  /** When true, this file is pure boilerplate and must be excluded from Call 2. */
  ignore_in_deep_review: boolean;
}

/**
 * Full response from auditInfra (Call 1).
 */
export interface InfraAuditResult {
  /** All files, sorted by weight descending. */
  files: ScoredFile[];
  summary: {
    total_files: number;
    total_lines: number;
    /** Paths of files with weight ≥ 60. */
    high_impact_files: string[];
    /** Boilerplate patterns detected in the repo (e.g. ["*.model.ts", "*.enum.ts"]). */
    ignored_patterns_detected: string[];
  };
}

/**
 * A single issue inside a deep-reviewed file.
 */
export interface DeepReviewIssue {
  severity: "HIGH" | "MEDIUM" | "LOW";
  type:
    | "SECURITY"
    | "RELIABILITY"
    | "MAINTAINABILITY"
    | "PERFORMANCE"
    | "CONFIG";
  description: string;
  /** Short code evidence (≤ 15 words). */
  evidence: string;
  suggested_fix: string;
}

/**
 * Per-file result from deepReview (Call 2).
 */
export interface DeepReviewedFile {
  path: string;
  overall_assessment: string;
  /** Estimated cyclomatic complexity score. */
  complexity_score: number;
  issues: DeepReviewIssue[];
}

/**
 * A cross-cutting repo-level finding from the deep review.
 */
export interface RepoLevelFinding {
  rank: number;
  title: string;
  detail: string;
  recommended_action: string;
}

/**
 * Full response from deepReview (Call 2).
 */
export interface DeepReviewResult {
  reviewed_files: DeepReviewedFile[];
  repo_level_findings: RepoLevelFinding[];
}

/**
 * Payload for the deep review call.
 * Built from the high-weight files selected by auditInfra.
 */
export interface DeepReviewRequest {
  /**
   * Map of relative-path → full source content.
   * Only files where ignore_in_deep_review = false should appear here.
   */
  fileContents: Record<string, string>;
  /**
   * Map of relative-path → content for direct imports of high-weight files.
   * Exclude boilerplate imports (pure model/enum/interface files).
   */
  importContents: Record<string, string>;
  /**
   * Map of relative-path → content for related HTML/template files
   * (Angular templates, React JSX siblings, Vue SFC templates, etc.).
   */
  templateContents: Record<string, string>;
}

/**
 * Payload for the infra audit call.
 */
export interface InfraAuditRequest {
  /** Raw package.json content as a string. */
  packageJson: string;
  /** Infra-related files: CI/CD, Dockerfiles, build configs, IaC, env files. */
  infraFiles: Record<string, string>;
  /** Full project file tree with per-file metadata. */
  fileTree: FileMetadata[];
}

// ─────────────────────────────────────────────────────────────────────────────
// IAiProvider — the contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IAiProvider
 *
 * Abstracts all generative AI capabilities behind a single port.
 * Implementations (GeminiProvider, MockProvider, etc.) live in
 * infrastructure/ai/ and are injected via the DependencyContainer.
 */
export interface IAiProvider {
  /**
   * Perform a code review focussing on quality, architecture, and security.
   *
   * @param request  Code payload and skill context.
   * @returns        Code findings and quality sub-scores.
   */
  reviewProject(request: ProjectReviewRequest): Promise<ProjectReviewResult>;

  /**
   * Perform an infrastructure and dependency (SCA) audit.
   *
   * @param request  IaC files, manifests, and project tree.
   * @returns        Infra and SCA findings.
   */
  reviewInfrastructure(request: InfraReviewRequest): Promise<InfraReviewResult>;

  /**
   * Generate a three-paragraph executive summary from the aggregated findings.
   *
   * The provider formats the prompt and calls the AI model.
   * Returns `undefined` if the summary generation fails — callers must handle
   * this gracefully.
   *
   * @param input  Aggregated stats and top findings for the prompt.
   */
  generateExecutiveSummary(
    input: ExecutiveSummaryInput,
  ): Promise<ExecutiveSummary | undefined>;

  /**
   * Generate or improve `.agents/skills/` SKILL.md files.
   *
   * Used by the BootstrapProject use case (the `init` command).
   *
   * @param prompt  The fully assembled prompt string.
   * @returns       A map from skill name to SKILL.md content.
   */
  generateSkills(prompt: string): Promise<Record<string, string>>;

  // ── Smart File Scoring ──────────────────────────────────────────────────

  /**
   * Call 1 — Infra audit & file weight calculation.
   *
   * Scores every file in the project tree by infrastructure/quality impact.
   * Pure boilerplate files (model, enum, DTO, etc.) are automatically marked
   * with `ignore_in_deep_review: true` so they are excluded from Call 2.
   *
   * @param request  package.json + infra files + full file-tree metadata.
   * @returns        All files ranked by weight, plus a summary with high-impact paths.
   */
  auditInfra(request: InfraAuditRequest): Promise<InfraAuditResult>;

  /**
   * Call 2 — Focused deep review on high-weight files.
   *
   * Reviews only the files NOT marked `ignore_in_deep_review` by Call 1,
   * together with their direct imports and paired templates.
   * Pure boilerplate files must NOT be included in the request.
   *
   * @param request  File contents + import contents + template contents.
   * @returns        Per-file issues and cross-cutting repo-level findings.
   */
  deepReview(request: DeepReviewRequest): Promise<DeepReviewResult>;
}
