// Copyright 2026 Google LLC

/**
 * GeminiProvider — implements IAiProvider using the Google Code Assist API.
 *
 * ## SRP: All Gemini-specific concerns live here
 *   - Prompt construction (unified system prompt, executive summary)
 *   - Model selection (FLASH for all reviews, PRO for summary/skills)
 *   - API call mechanics (codeAssistPost, extractResponseText)
 *   - Response parsing & error handling
 *
 * The application layer (RunCodeReview) is completely unaware of these details.
 *
 * ## Single-call design
 *   reviewProject() sends ONE request to Gemini 2.5 Flash with the full
 *   code + IaC + manifest payload, returning code findings, infra findings,
 *   and sub-scores in a single structured JSON response.
 */

import { GeminiModel, CODE_ASSIST_BASE_URL } from "../../shared/constants.js";
import type {
  IAiProvider,
  ProjectReviewRequest,
  ProjectReviewResult,
  InfraReviewRequest,
  InfraReviewResult,
  ExecutiveSummaryInput,
} from "../../core/interfaces/IAiProvider.js";
import type {
  ExecutiveSummary,
  InfraFindingEntity,
  AiSubScores,
} from "../../core/entities/ProjectReport.js";
import type { ReviewFinding } from "../../core/entities/ReviewFinding.js";
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  INFRA_REVIEW_SYSTEM_PROMPT,
  EXECUTIVE_SUMMARY_PROMPT,
  GENERATE_SKILLS_SYSTEM_PROMPT,
} from "./prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON schemas (Gemini structured output)
// ─────────────────────────────────────────────────────────────────────────────

/** Shared finding schema used for both code and infra findings. */
const CODE_FINDING_SCHEMA = {
  type: "OBJECT",
  properties: {
    file: { type: "STRING", description: "Exact relative file path." },
    line: { type: "NUMBER", description: "1-indexed line number." },
    snippet: {
      type: "STRING",
      description: "Short specific snippet (≤10 words) for accurate location.",
    },
    suggestion: { type: "STRING", description: "Actionable fix suggestion." },
    category: {
      type: "STRING",
      description:
        "Focus area: SOLID, Naming, Security/Injection, CleanCode, Performance, etc.",
    },
    priority: { type: "STRING", enum: ["low", "medium", "high"] },
    recommendedFix: {
      type: "OBJECT",
      description:
        "Before/after pair for HIGH-priority Security findings only.",
      properties: {
        before: {
          type: "STRING",
          description: "1–4 lines of vulnerable code.",
        },
        after: {
          type: "STRING",
          description: "1–4 lines of corrected code.",
        },
      },
    },
  },
  required: ["file", "line", "snippet", "suggestion", "category", "priority"],
};

const INFRA_FINDING_SCHEMA = {
  type: "OBJECT",
  properties: {
    file: { type: "STRING" },
    line: { type: "NUMBER" },
    category: {
      type: "STRING",
      enum: [
        "misconfiguration",
        "outdated-image",
        "privilege-escalation",
        "open-exposure",
        "vulnerable-dependency",
        "insecure-default",
        "other",
      ],
    },
    title: { type: "STRING" },
    description: { type: "STRING" },
    remediation: { type: "STRING" },
    severity: {
      type: "STRING",
      enum: ["critical", "high", "medium", "low"],
    },
  },
  required: [
    "file",
    "category",
    "title",
    "description",
    "remediation",
    "severity",
  ],
};

/**
 * Code review response schema.
 */
const CODE_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    // ─── Code quality sub-scores ─────────────────────────────────────────
    score: {
      type: "NUMBER",
      description: "Overall code quality score 0–100.",
    },
    solidPrinciplesScore: {
      type: "NUMBER",
      description: "SOLID adherence score 0–100.",
    },
    namingConventionScore: {
      type: "NUMBER",
      description: "Naming quality score 0–100.",
    },
    maintainabilityIndex: {
      type: "NUMBER",
      description: "Maintainability index 0–100 (higher = more maintainable).",
    },
    cyclomaticComplexity: {
      type: "NUMBER",
      description: "Estimated average cyclomatic complexity per function.",
    },
    codeDuplicationPercentage: {
      type: "NUMBER",
      description: "Estimated % of duplicated code blocks.",
    },
    // ─── Findings ────────────────────────────────────────────────────────
    codeFindings: {
      type: "ARRAY",
      description: "Code quality, security, and architectural findings.",
      items: CODE_FINDING_SCHEMA,
    },
  },
  required: [
    "score",
    "solidPrinciplesScore",
    "namingConventionScore",
    "maintainabilityIndex",
    "cyclomaticComplexity",
    "codeDuplicationPercentage",
    "codeFindings",
  ],
};

/**
 * Infrastructure review response schema.
 */
const INFRA_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    infraFindings: {
      type: "ARRAY",
      description:
        "IaC misconfigurations, container security, SCA/CVE findings.",
      items: INFRA_FINDING_SCHEMA,
    },
  },
  required: ["infraFindings"],
};

const EXECUTIVE_SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    what: { type: "STRING" },
    impact: { type: "STRING" },
    risk: { type: "STRING" },
  },
  required: ["what", "impact", "risk"],
};

const SKILLS_SCHEMA = {
  type: "OBJECT",
  properties: {
    "coding-standards": { type: "STRING" },
    "testing-philosophy": { type: "STRING" },
    "ci-cd-requirements": { type: "STRING" },
    "architecture-patterns": { type: "STRING" },
  },
  required: [
    "coding-standards",
    "testing-philosophy",
    "ci-cd-requirements",
    "architecture-patterns",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Response shape (minimal typed wrapper to avoid `any` everywhere)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse {
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_SECONDS = [15, 30, 60];

/**
 * POST to a Code Assist method (e.g. `generateContent`, `loadCodeAssist`).
 * Automatically retries on 429 (rate limit) responses, waiting for the
 * server-suggested cooldown period before each retry.
 * Throws on non-2xx responses after retries are exhausted.
 */
async function codeAssistPost(
  method: string,
  body: unknown,
  token: string,
  logDebug: (msg: string) => void,
): Promise<ApiResponse> {
  const endpoint = `${CODE_ASSIST_BASE_URL}:${method}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logDebug(
      `POST ${endpoint}${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ""}`,
    );

    const httpStart = performance.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const httpMs = performance.now() - httpStart;

    if (res.ok) {
      logDebug(
        `[timing:http] ${method} → HTTP ${res.status} in ${httpMs.toFixed(0)}ms`,
      );
      return res.json() as Promise<ApiResponse>;
    }

    const errText = await res.text();
    logDebug(
      `[timing:http] ${method} → HTTP ${res.status} in ${httpMs.toFixed(0)}ms (error)`,
    );

    // Retry on 429 rate-limit errors
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const match = errText.match(/reset after (\d+)s/);
      const waitSeconds = match
        ? parseInt(match[1], 10) + 2
        : (DEFAULT_BACKOFF_SECONDS[attempt] ?? 30);

      logDebug(
        `Rate limited (429). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES}...`,
      );
      await sleep(waitSeconds * 1000);
      continue;
    }

    throw new Error(`HTTP ${res.status} on ${method}: ${errText}`);
  }

  throw new Error(`Exhausted ${MAX_RETRIES} retries on ${method}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the text from the first candidate of a Code Assist generateContent
 * response. Returns `"{}"` (safe default for JSON.parse callers) when the
 * shape is unexpected.
 */
function extractResponseText(json: ApiResponse): string {
  return json?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
}

// ─────────────────────────────────────────────────────────────────────────────
// GeminiProvider
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiProvider implements IAiProvider {
  constructor(
    private readonly accessToken: string,
    private readonly cloudProject: string,
    private readonly logDebug: (msg: string) => void,
  ) {}

  // ── IAiProvider.reviewProject ─────────────────────────────────────────────

  /**
   * Code review focussed on quality, architecture, and security.
   *
   * Model: Gemini 2.5 Flash (large context window, fast, structured output).
   * Temperature: 0.1 (deterministic, analytical output).
   */
  async reviewProject(
    request: ProjectReviewRequest,
  ): Promise<ProjectReviewResult> {
    const systemPrompt = CODE_REVIEW_SYSTEM_PROMPT(
      request.skillsContext ?? "",
      request.feedbackSuffix ?? "",
    );

    const userPrompt = `## SOURCE CODE\n\n${request.codePayload}`;

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: CODE_REVIEW_SCHEMA,
        },
      },
    };

    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    this.logDebug(
      `reviewProject: ~${estimatedTokens} tokens, model: ${GeminiModel.FLASH}`,
    );

    const json = await codeAssistPost(
      "generateContent",
      requestBody,
      this.accessToken,
      this.logDebug,
    );

    const responseText = extractResponseText(json);
    const parsed = JSON.parse(responseText) as Record<string, unknown>;

    return {
      codeFindings: this.extractCodeFindings(parsed),
      subScores: this.extractSubScores(parsed),
    };
  }

  // ── IAiProvider.reviewInfrastructure ──────────────────────────────────────

  /**
   * Infrastructure and SCA audit call.
   * Only includes IaC files, manifests, and the project tree.
   */
  async reviewInfrastructure(
    request: InfraReviewRequest,
  ): Promise<InfraReviewResult> {
    const systemPrompt = INFRA_REVIEW_SYSTEM_PROMPT;

    const userPrompt = this.buildInfraUserPrompt(
      request.iacFiles,
      request.dependencyManifests,
      request.projectTree,
    );

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: INFRA_REVIEW_SCHEMA,
        },
      },
    };

    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    this.logDebug(
      `reviewInfrastructure: ~${estimatedTokens} tokens, model: ${GeminiModel.FLASH}`,
    );

    const json = await codeAssistPost(
      "generateContent",
      requestBody,
      this.accessToken,
      this.logDebug,
    );

    const responseText = extractResponseText(json);
    const parsed = JSON.parse(responseText) as Record<string, unknown>;

    return {
      infraFindings: this.extractInfraFindings(parsed),
    };
  }

  // ── IAiProvider.generateExecutiveSummary ─────────────────────────────────

  async generateExecutiveSummary(
    input: ExecutiveSummaryInput,
  ): Promise<ExecutiveSummary | undefined> {
    const prompt = EXECUTIVE_SUMMARY_PROMPT(input);

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: EXECUTIVE_SUMMARY_SCHEMA,
        },
      },
    };

    try {
      const json = await codeAssistPost(
        "generateContent",
        requestBody,
        this.accessToken,
        this.logDebug,
      );
      const text = extractResponseText(json);
      const parsed = JSON.parse(text) as {
        what?: string;
        impact?: string;
        risk?: string;
      };

      return {
        what: parsed.what ?? "Summary unavailable.",
        impact: parsed.impact ?? "Impact unavailable.",
        risk: parsed.risk ?? "Risk unavailable.",
        isPublicFacing: input.isPublicFacing,
      };
    } catch (e: any) {
      this.logDebug(`generateExecutiveSummary failed: ${e.message}`);
      return undefined;
    }
  }

  // ── IAiProvider.generateSkills ───────────────────────────────────────────

  async generateSkills(prompt: string): Promise<Record<string, string>> {
    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: {
          role: "system",
          parts: [{ text: GENERATE_SKILLS_SYSTEM_PROMPT }],
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          responseMimeType: "application/json",
          responseSchema: SKILLS_SCHEMA,
        },
      },
    };

    this.logDebug(
      `generateSkills: model=${GeminiModel.FLASH}, prompt=${prompt.length} chars`,
    );

    const json = await codeAssistPost(
      "generateContent",
      requestBody,
      this.accessToken,
      this.logDebug,
    );
    const responseText = extractResponseText(json);

    try {
      return JSON.parse(responseText) as Record<string, string>;
    } catch {
      throw new Error(
        `Gemini returned non-JSON for skill generation: ${responseText.slice(0, 200)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Prompt builder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Assembles the user-turn prompt for the infrastructure audit call.
   * Combines IaC files, dependency manifests, and the project tree.
   */
  private buildInfraUserPrompt(
    iacFiles: Record<string, string>,
    dependencyManifests: Record<string, string>,
    projectTree: string,
  ): string {
    const sections: string[] = [];

    sections.push(
      `## PROJECT TREE (Structure Context)\n\`\`\`\n${projectTree}\n\`\`\``,
    );

    for (const [name, content] of Object.entries(iacFiles)) {
      sections.push(`## IaC File: ${name}\n\`\`\`\n${content}\n\`\`\``);
    }

    for (const [name, content] of Object.entries(dependencyManifests)) {
      sections.push(
        `## Dependency Manifest: ${name}\n\`\`\`\n${content}\n\`\`\``,
      );
    }

    return sections.join("\n\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Response parsers
  // ─────────────────────────────────────────────────────────────────────────

  private extractCodeFindings(
    parsed: Record<string, unknown>,
  ): ReviewFinding[] {
    if (!Array.isArray(parsed["codeFindings"])) return [];

    return (parsed["codeFindings"] as Record<string, unknown>[])
      .filter((f) => f["file"] && f["snippet"])
      .map((f) => ({
        file: String(f["file"]),
        line: typeof f["line"] === "number" ? f["line"] : 1,
        snippet: String(f["snippet"] ?? ""),
        suggestion: String(f["suggestion"] ?? ""),
        category: typeof f["category"] === "string" ? f["category"] : undefined,
        priority: (["low", "medium", "high"].includes(String(f["priority"]))
          ? f["priority"]
          : "low") as ReviewFinding["priority"],
        recommendedFix:
          f["recommendedFix"] &&
          typeof (f["recommendedFix"] as any)["before"] === "string" &&
          typeof (f["recommendedFix"] as any)["after"] === "string"
            ? {
                before: (f["recommendedFix"] as any)["before"],
                after: (f["recommendedFix"] as any)["after"],
              }
            : undefined,
      }));
  }

  private extractInfraFindings(
    parsed: Record<string, unknown>,
  ): InfraFindingEntity[] {
    if (!Array.isArray(parsed["infraFindings"])) return [];

    return (parsed["infraFindings"] as Record<string, unknown>[])
      .filter((f) => f["file"] && f["title"])
      .map((f) => ({
        file: String(f["file"]),
        line: typeof f["line"] === "number" ? f["line"] : undefined,
        category: String(f["category"] ?? "other"),
        title: String(f["title"] ?? ""),
        description: String(f["description"] ?? ""),
        remediation: String(f["remediation"] ?? ""),
        severity: (["critical", "high", "medium", "low"].includes(
          String(f["severity"]),
        )
          ? f["severity"]
          : "medium") as InfraFindingEntity["severity"],
      }));
  }

  private extractSubScores(parsed: Record<string, unknown>): AiSubScores {
    const num = (key: string) =>
      typeof parsed[key] === "number" ? (parsed[key] as number) : undefined;
    return {
      namingConventionScore: num("namingConventionScore"),
      solidPrinciplesScore: num("solidPrinciplesScore"),
      codeDuplicationPercentage: num("codeDuplicationPercentage"),
      cyclomaticComplexity: num("cyclomaticComplexity"),
      maintainabilityIndex: num("maintainabilityIndex"),
    };
  }
}
