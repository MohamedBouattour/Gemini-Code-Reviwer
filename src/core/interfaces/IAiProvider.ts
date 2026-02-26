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
 * A self-contained batch of code files sent to the AI for review.
 * The orchestrator splits the full project into several of these
 * to stay within token limits.
 */
export interface CodeReviewBatch {
  /** The combined XML-tagged payload for the AI prompt. */
  payload: string;
  /** Relative paths of the files in this batch (for progress reporting). */
  files: string[];
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
   * Review a single batch of code files.
   *
   * The provider is responsible for:
   *   - Constructing the system prompt (taint analysis instructions, skills
   *     context, feedback suppressions, etc.)
   *   - Calling the underlying AI model
   *   - Parsing and returning structured findings + batch sub-scores
   *
   * The application layer does NOT know about prompts, schemas, or models.
   *
   * @param batch     The code payload to review.
   * @param context   Optional strings injected into the system prompt
   *                  (e.g., skills context, false-positive suppressions).
   * @returns         The findings and sub-scores for this batch.
   */
  reviewCodeBatch(
    batch: CodeReviewBatch,
    context?: { skillsContext?: string; feedbackSuffix?: string },
  ): Promise<CodeBatchResult>;

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
   * Audit IaC and dependency manifests for security misconfigurations.
   *
   * This is separated from `reviewCodeBatch` because it uses a different
   * model temperature, system prompt, and response schema.
   *
   * @param iacFiles             Map of relative-path → file-content for IaC files.
   * @param dependencyManifests  Map of relative-path → file-content for package lock files, etc.
   */
  auditInfrastructure(
    iacFiles: Record<string, string>,
    dependencyManifests: Record<string, string>,
  ): Promise<InfraFindingEntity[]>;

  /**
   * Generate or improve `.agents/skills/` SKILL.md files.
   *
   * Used by the BootstrapProject use case (the `init` command).
   *
   * @param prompt  The fully assembled prompt string.
   * @returns       A map from skill name to SKILL.md content.
   */
  generateSkills(prompt: string): Promise<Record<string, string>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Return types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a single code review batch call.
 */
export interface CodeBatchResult {
  findings: ReviewFinding[];
  subScores: AiSubScores;
}
