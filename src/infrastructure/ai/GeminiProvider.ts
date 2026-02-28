// Copyright 2026 Google LLC

/**
 * GeminiProvider — implements IAiProvider using the Google Code Assist API.
 *
 * ## Changes in this version
 *
 *   - AiCallLogger is always-on (no debug gate). Every call writes a JSON
 *     record to gemini-code-reviewer/ai-calls/<ts>_<callName>.json.
 *
 *   - codeAssistPost now returns { data, retryCount } so each AI method
 *     can pass the actual retry count to AiCallLogger for diagnosis.
 *
 *   - The `debug` constructor parameter is REMOVED — the logger is always
 *     constructed and always writes.
 *
 *   - outputDir is now a required constructor parameter so AiCallLogger
 *     writes to the correct project-specific directory.
 */

import { GeminiModel, CODE_ASSIST_BASE_URL } from "../../shared/constants.js";
import type {
  IAiProvider,
  ProjectReviewRequest,
  ProjectReviewResult,
  InfraReviewRequest,
  InfraReviewResult,
  ExecutiveSummaryInput,
  InfraAuditRequest,
  InfraAuditResult,
  DeepReviewRequest,
  DeepReviewResult,
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
  INFRA_AUDIT_SYSTEM_PROMPT,
  DEEP_REVIEW_SYSTEM_PROMPT,
} from "./prompts.js";
import { AiCallLogger } from "./AiCallLogger.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON schemas (Gemini structured output)
// ─────────────────────────────────────────────────────────────────────────────

const CODE_FINDING_SCHEMA = {
  type: "OBJECT",
  properties: {
    file: { type: "STRING" },
    line: { type: "NUMBER" },
    snippet: { type: "STRING" },
    suggestion: { type: "STRING" },
    category: { type: "STRING" },
    priority: { type: "STRING", enum: ["low", "medium", "high"] },
    recommendedFix: {
      type: "OBJECT",
      properties: {
        before: { type: "STRING" },
        after: { type: "STRING" },
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
        "misconfiguration", "outdated-image", "privilege-escalation",
        "open-exposure", "vulnerable-dependency", "insecure-default", "other",
      ],
    },
    title: { type: "STRING" },
    description: { type: "STRING" },
    remediation: { type: "STRING" },
    severity: { type: "STRING", enum: ["critical", "high", "medium", "low"] },
  },
  required: ["file", "category", "title", "description", "remediation", "severity"],
};

const CODE_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER" },
    solidPrinciplesScore: { type: "NUMBER" },
    namingConventionScore: { type: "NUMBER" },
    maintainabilityIndex: { type: "NUMBER" },
    cyclomaticComplexity: { type: "NUMBER" },
    codeDuplicationPercentage: { type: "NUMBER" },
    codeFindings: { type: "ARRAY", items: CODE_FINDING_SCHEMA },
  },
  required: [
    "score", "solidPrinciplesScore", "namingConventionScore",
    "maintainabilityIndex", "cyclomaticComplexity", "codeDuplicationPercentage",
    "codeFindings",
  ],
};

const INFRA_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    infraFindings: { type: "ARRAY", items: INFRA_FINDING_SCHEMA },
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
    "coding-standards", "testing-philosophy",
    "ci-cd-requirements", "architecture-patterns",
  ],
};

const SCORED_FILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    path: { type: "STRING" },
    extension: { type: "STRING" },
    lines: { type: "NUMBER" },
    bytes: { type: "NUMBER" },
    weight: { type: "NUMBER" },
    reason: { type: "STRING" },
    ignore_in_deep_review: { type: "BOOLEAN" },
  },
  required: ["path", "extension", "lines", "bytes", "weight", "reason", "ignore_in_deep_review"],
};

const INFRA_AUDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    files: { type: "ARRAY", items: SCORED_FILE_SCHEMA },
    summary: {
      type: "OBJECT",
      properties: {
        total_files: { type: "NUMBER" },
        total_lines: { type: "NUMBER" },
        high_impact_files: { type: "ARRAY", items: { type: "STRING" } },
        ignored_patterns_detected: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["total_files", "total_lines", "high_impact_files", "ignored_patterns_detected"],
    },
  },
  required: ["files", "summary"],
};

const DEEP_REVIEW_ISSUE_SCHEMA = {
  type: "OBJECT",
  properties: {
    severity: { type: "STRING", enum: ["HIGH", "MEDIUM", "LOW"] },
    type: { type: "STRING", enum: ["SECURITY", "RELIABILITY", "MAINTAINABILITY", "PERFORMANCE", "CONFIG"] },
    description: { type: "STRING" },
    evidence: { type: "STRING" },
    suggested_fix: { type: "STRING" },
  },
  required: ["severity", "type", "description", "evidence", "suggested_fix"],
};

const DEEP_REVIEWED_FILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    path: { type: "STRING" },
    overall_assessment: { type: "STRING" },
    complexity_score: { type: "NUMBER" },
    issues: { type: "ARRAY", items: DEEP_REVIEW_ISSUE_SCHEMA },
  },
  required: ["path", "overall_assessment", "complexity_score", "issues"],
};

const REPO_LEVEL_FINDING_SCHEMA = {
  type: "OBJECT",
  properties: {
    rank: { type: "NUMBER" },
    title: { type: "STRING" },
    detail: { type: "STRING" },
    recommended_action: { type: "STRING" },
  },
  required: ["rank", "title", "detail", "recommended_action"],
};

const DEEP_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    reviewed_files: { type: "ARRAY", items: DEEP_REVIEWED_FILE_SCHEMA },
    repo_level_findings: { type: "ARRAY", items: REPO_LEVEL_FINDING_SCHEMA },
  },
  required: ["reviewed_files", "repo_level_findings"],
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse {
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
}

/** Return value of codeAssistPost — includes retry telemetry. */
interface PostResult {
  data: ApiResponse;
  retryCount: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_SECONDS = [15, 30, 60];

/**
 * codeAssistPost — POST to the Code Assist API with retry-after-aware backoff.
 *
 * Returns { data, retryCount, durationMs } so callers can surface these
 * values in AiCallLogger records for timing diagnosis.
 */
async function codeAssistPost(
  method: string,
  body: unknown,
  token: string,
  logDebug: (msg: string) => void,
): Promise<PostResult> {
  const endpoint = `${CODE_ASSIST_BASE_URL}:${method}`;
  let retryCount = 0;
  const totalStart = performance.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logDebug(
      `POST ${endpoint}${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ""}`,
    );

    const attemptStart = performance.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const attemptMs = Math.round(performance.now() - attemptStart);

    if (res.ok) {
      const durationMs = Math.round(performance.now() - totalStart);
      logDebug(`[timing:http] ${method} → HTTP ${res.status} in ${attemptMs}ms (total: ${durationMs}ms, retries: ${retryCount})`);
      const data = (await res.json()) as ApiResponse;
      return { data, retryCount, durationMs };
    }

    const errText = await res.text();
    logDebug(`[timing:http] ${method} → HTTP ${res.status} in ${attemptMs}ms (error)`);

    if (res.status === 429 && attempt < MAX_RETRIES) {
      retryCount++;
      // Prefer Retry-After header, then parse body, then use default backoff
      const retryAfterHeader = res.headers.get("Retry-After");
      const bodyMatch = errText.match(/reset after (\d+)s/);
      const waitSeconds = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) + 1
        : bodyMatch
          ? parseInt(bodyMatch[1], 10) + 2
          : (DEFAULT_BACKOFF_SECONDS[attempt] ?? 30);
      logDebug(`Rate limited (429). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
      await sleep(waitSeconds * 1_000);
      continue;
    }

    throw new Error(`HTTP ${res.status} on ${method}: ${errText}`);
  }

  throw new Error(`Exhausted ${MAX_RETRIES} retries on ${method}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractResponseText(json: ApiResponse): string {
  return json?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
}

// ─────────────────────────────────────────────────────────────────────────────
// GeminiProvider
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiProvider implements IAiProvider {
  private readonly callLogger: AiCallLogger;

  constructor(
    private readonly accessToken: string,
    private readonly cloudProject: string,
    private readonly logDebug: (msg: string) => void,
    /** Output directory for call logs (e.g. `<baseDir>/gemini-code-reviewer`). */
    outputDir = process.cwd(),
  ) {
    // AiCallLogger is always-on — no debug gate
    this.callLogger = new AiCallLogger(
      require("node:path").join(outputDir),
      logDebug,
    );
  }

  // ── IAiProvider.reviewProject ──────────────────────────────────────────────

  async reviewProject(request: ProjectReviewRequest): Promise<ProjectReviewResult> {
    const systemPrompt = CODE_REVIEW_SYSTEM_PROMPT(request.skillsContext ?? "", request.feedbackSuffix ?? "");
    const userPrompt = `## SOURCE CODE\n\n${request.codePayload}`;
    const model = GeminiModel.FLASH;
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: CODE_REVIEW_SCHEMA },
      },
    };
    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    this.logDebug(`reviewProject: ~${estimatedTokens} tokens`);
    const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
    const parsed = JSON.parse(extractResponseText(data)) as Record<string, unknown>;
    this.callLogger.persist("reviewProject", model, requestBody, parsed, durationMs, estimatedTokens, retryCount);
    return { codeFindings: this.extractCodeFindings(parsed), subScores: this.extractSubScores(parsed) };
  }

  // ── IAiProvider.reviewInfrastructure ─────────────────────────────────────────

  async reviewInfrastructure(request: InfraReviewRequest): Promise<InfraReviewResult> {
    const model = GeminiModel.FLASH;
    const userPrompt = this.buildInfraUserPrompt(request.iacFiles, request.dependencyManifests, request.projectTree);
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: INFRA_REVIEW_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: INFRA_REVIEW_SCHEMA },
      },
    };
    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
    const parsed = JSON.parse(extractResponseText(data)) as Record<string, unknown>;
    this.callLogger.persist("reviewInfrastructure", model, requestBody, parsed, durationMs, estimatedTokens, retryCount);
    return { infraFindings: this.extractInfraFindings(parsed) };
  }

  // ── IAiProvider.generateExecutiveSummary ─────────────────────────────────

  async generateExecutiveSummary(input: ExecutiveSummaryInput): Promise<ExecutiveSummary | undefined> {
    const model = GeminiModel.FLASH;
    const prompt = EXECUTIVE_SUMMARY_PROMPT(input);
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: EXECUTIVE_SUMMARY_SCHEMA },
      },
    };
    try {
      const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
      const parsed = JSON.parse(extractResponseText(data)) as { what?: string; impact?: string; risk?: string };
      this.callLogger.persist("generateExecutiveSummary", model, requestBody, parsed, durationMs, Math.ceil(prompt.length / 4), retryCount);
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
    const model = GeminiModel.FLASH;
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: GENERATE_SKILLS_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, responseMimeType: "application/json", responseSchema: SKILLS_SCHEMA },
      },
    };
    const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
    const parsed = JSON.parse(extractResponseText(data)) as Record<string, string>;
    this.callLogger.persist("generateSkills", model, requestBody, parsed, durationMs, Math.ceil(prompt.length / 4), retryCount);
    return parsed;
  }

  // ── IAiProvider.auditInfra (Call 1) ────────────────────────────────────────

  async auditInfra(request: InfraAuditRequest): Promise<InfraAuditResult> {
    const model = GeminiModel.FLASH;
    const userPrompt = this.buildInfraAuditUserPrompt(request);
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: INFRA_AUDIT_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.0, responseMimeType: "application/json", responseSchema: INFRA_AUDIT_SCHEMA },
      },
    };
    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    this.logDebug(`auditInfra: ~${estimatedTokens} tokens, files=${request.fileTree.length}`);
    const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
    const parsed = JSON.parse(extractResponseText(data)) as InfraAuditResult;
    this.callLogger.persist("auditInfra", model, requestBody, parsed, durationMs, estimatedTokens, retryCount);
    this.logDebug(`auditInfra: ${parsed.files.length} files scored, retries=${retryCount}, durationMs=${durationMs}`);
    return parsed;
  }

  // ── IAiProvider.deepReview (Call 2) ───────────────────────────────────────

  async deepReview(request: DeepReviewRequest): Promise<DeepReviewResult> {
    const model = GeminiModel.FLASH;
    const userPrompt = this.buildDeepReviewUserPrompt(request);
    const requestBody = {
      model, project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: DEEP_REVIEW_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: DEEP_REVIEW_SCHEMA },
      },
    };
    const estimatedTokens = Math.ceil(userPrompt.length / 4);
    this.logDebug(`deepReview: ~${estimatedTokens} tokens, files=${Object.keys(request.fileContents).length}`);
    const { data, retryCount, durationMs } = await codeAssistPost("generateContent", requestBody, this.accessToken, this.logDebug);
    const parsed = JSON.parse(extractResponseText(data)) as DeepReviewResult;
    this.callLogger.persist("deepReview", model, requestBody, parsed, durationMs, estimatedTokens, retryCount);
    this.logDebug(`deepReview: ${parsed.reviewed_files.length} files reviewed, retries=${retryCount}, durationMs=${durationMs}`);
    return parsed;
  }

  // ── Private: Prompt builders ─────────────────────────────────────────────────

  private buildInfraUserPrompt(iacFiles: Record<string, string>, dependencyManifests: Record<string, string>, projectTree: string): string {
    const sections: string[] = [];
    sections.push(`## PROJECT TREE\n\`\`\`\n${projectTree}\n\`\`\``);
    for (const [name, content] of Object.entries(iacFiles)) sections.push(`## IaC File: ${name}\n\`\`\`\n${content}\n\`\`\``);
    for (const [name, content] of Object.entries(dependencyManifests)) sections.push(`## Dependency Manifest: ${name}\n\`\`\`\n${content}\n\`\`\``);
    return sections.join("\n\n");
  }

  private buildInfraAuditUserPrompt(request: InfraAuditRequest): string {
    const sections: string[] = [];
    sections.push(`## package.json\n\`\`\`json\n${request.packageJson}\n\`\`\``);
    for (const [name, content] of Object.entries(request.infraFiles)) sections.push(`## Infra File: ${name}\n\`\`\`\n${content}\n\`\`\``);
    const treeManifest = request.fileTree
      .map((f) => `{ "path": "${f.path}", "extension": "${f.extension}", "bytes": ${f.bytes}, "lines": ${f.lines} }`)
      .join("\n");
    sections.push(`## Full Project File Tree (${request.fileTree.length} files)\n\`\`\`json\n[\n${treeManifest}\n]\n\`\`\``);
    return sections.join("\n\n");
  }

  private buildDeepReviewUserPrompt(request: DeepReviewRequest): string {
    const sections: string[] = [];
    const fileCount = Object.keys(request.fileContents).length;
    sections.push(`## High-Impact Files Under Review (${fileCount} files)\n> Selected by infra audit (weight ≥ threshold, not ignored).`);
    for (const [filePath, content] of Object.entries(request.fileContents)) {
      const ext = filePath.split(".").pop() ?? "";
      sections.push(`### ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\``);
    }
    if (Object.keys(request.importContents).length > 0) {
      sections.push(`## Direct Imports (context only)\n> Do NOT flag issues in these unless they directly cause a problem in the files above.`);
      for (const [filePath, content] of Object.entries(request.importContents)) {
        const ext = filePath.split(".").pop() ?? "";
        sections.push(`### ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\``);
      }
    }
    if (Object.keys(request.templateContents).length > 0) {
      sections.push(`## Paired Templates`);
      for (const [filePath, content] of Object.entries(request.templateContents)) {
        sections.push(`### ${filePath}\n\`\`\`html\n${content}\n\`\`\``);
      }
    }
    return sections.join("\n\n");
  }

  // ── Private: Response parsers ─────────────────────────────────────────────────

  private extractCodeFindings(parsed: Record<string, unknown>): ReviewFinding[] {
    if (!Array.isArray(parsed["codeFindings"])) return [];
    return (parsed["codeFindings"] as Record<string, unknown>[])
      .filter((f) => f["file"] && f["snippet"])
      .map((f) => ({
        file: String(f["file"]),
        line: typeof f["line"] === "number" ? f["line"] : 1,
        snippet: String(f["snippet"] ?? ""),
        suggestion: String(f["suggestion"] ?? ""),
        category: typeof f["category"] === "string" ? f["category"] : undefined,
        priority: (["low", "medium", "high"].includes(String(f["priority"])) ? f["priority"] : "low") as ReviewFinding["priority"],
        recommendedFix:
          f["recommendedFix"] &&
          typeof (f["recommendedFix"] as Record<string, unknown>)["before"] === "string" &&
          typeof (f["recommendedFix"] as Record<string, unknown>)["after"] === "string"
            ? { before: String((f["recommendedFix"] as Record<string, unknown>)["before"]), after: String((f["recommendedFix"] as Record<string, unknown>)["after"]) }
            : undefined,
      }));
  }

  private extractInfraFindings(parsed: Record<string, unknown>): InfraFindingEntity[] {
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
        severity: (["critical", "high", "medium", "low"].includes(String(f["severity"])) ? f["severity"] : "medium") as InfraFindingEntity["severity"],
      }));
  }

  private extractSubScores(parsed: Record<string, unknown>): AiSubScores {
    const num = (key: string) => typeof parsed[key] === "number" ? (parsed[key] as number) : undefined;
    return {
      namingConventionScore: num("namingConventionScore"),
      solidPrinciplesScore: num("solidPrinciplesScore"),
      codeDuplicationPercentage: num("codeDuplicationPercentage"),
      cyclomaticComplexity: num("cyclomaticComplexity"),
      maintainabilityIndex: num("maintainabilityIndex"),
    };
  }
}
