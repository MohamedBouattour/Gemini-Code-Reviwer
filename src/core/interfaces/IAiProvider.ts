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
}
