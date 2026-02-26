// Copyright 2026 Google LLC

/**
 * GeminiProvider — implements IAiProvider using the Google Code Assist API.
 *
 * ## SRP: All Gemini-specific concerns live here
 *   - Prompt construction (system prompt, safety instructions, schemas)
 *   - Model selection (FLASH for review batches, PRO for summaries/skills)
 *   - API call mechanics (codeAssistPost, extractResponseText)
 *   - Response parsing & error handling
 *
 * The application layer (RunCodeReview) is completely unaware of these details.
 */

import { GeminiModel, CODE_ASSIST_BASE_URL } from "../../shared/constants.js";
import type {
  IAiProvider,
  CodeReviewBatch,
  CodeBatchResult,
  ShallowReviewResult,
  ExecutiveSummaryInput,
} from "../../core/interfaces/IAiProvider.js";
import type {
  ExecutiveSummary,
  InfraFindingEntity,
  AiSubScores,
} from "../../core/entities/ProjectReport.js";
import type { ReviewFinding } from "../../core/entities/ReviewFinding.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON schemas (Gemini structured output)
// ─────────────────────────────────────────────────────────────────────────────

const CODE_REVIEW_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: {
      type: "NUMBER",
      description: "Logic/arch score 0–100 for this batch.",
    },
    namingConventionScore: {
      type: "NUMBER",
      description: "Score 0–100 for naming conventions.",
    },
    solidPrinciplesScore: {
      type: "NUMBER",
      description: "Score 0–100 for SOLID principles.",
    },
    codeDuplicationPercentage: {
      type: "NUMBER",
      description: "Estimated % code duplication.",
    },
    cyclomaticComplexity: {
      type: "NUMBER",
      description: "Estimated avg cyclomatic complexity.",
    },
    maintainabilityIndex: {
      type: "NUMBER",
      description: "Estimated maintainability index 0–100.",
    },
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          file: { type: "STRING", description: "Exact relative file path." },
          line: { type: "NUMBER", description: "Line number." },
          snippet: {
            type: "STRING",
            description: "Specific snippet being flagged.",
          },
          suggestion: { type: "STRING", description: "Actionable suggestion." },
          category: {
            type: "STRING",
            description: "Focus area (Naming, SOLID, Security/Injection, etc.)",
          },
          priority: { type: "STRING", enum: ["low", "medium", "high"] },
          recommendedFix: {
            type: "OBJECT",
            description: "For HIGH-priority Security findings only.",
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
        required: [
          "file",
          "line",
          "snippet",
          "suggestion",
          "category",
          "priority",
        ],
      },
    },
  },
  required: [
    "score",
    "namingConventionScore",
    "solidPrinciplesScore",
    "codeDuplicationPercentage",
    "cyclomaticComplexity",
    "maintainabilityIndex",
    "findings",
  ],
};

/**
 * Schema for the shallow / oneshot whole-codebase scan.
 * Only returns global-level metrics — no findings array.
 */
const SHALLOW_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    codeDuplicationPercentage: {
      type: "NUMBER",
      description: "Estimated % of duplicated code across the entire codebase.",
    },
    cyclomaticComplexity: {
      type: "NUMBER",
      description:
        "Estimated average cyclomatic complexity across all functions.",
    },
    maintainabilityIndex: {
      type: "NUMBER",
      description:
        "Estimated maintainability index 0–100 for the whole codebase.",
    },
  },
  required: [
    "codeDuplicationPercentage",
    "cyclomaticComplexity",
    "maintainabilityIndex",
  ],
};

/**
 * Schema for the deep / per-chunk review.
 * Returns detailed findings plus per-chunk naming and SOLID scores.
 */
const DEEP_CHUNK_REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    namingConventionScore: {
      type: "NUMBER",
      description: "Score 0–100 for naming conventions in this chunk.",
    },
    solidPrinciplesScore: {
      type: "NUMBER",
      description: "Score 0–100 for SOLID principles in this chunk.",
    },
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          file: { type: "STRING", description: "Exact relative file path." },
          line: { type: "NUMBER", description: "Line number." },
          snippet: {
            type: "STRING",
            description: "Specific snippet being flagged.",
          },
          suggestion: { type: "STRING", description: "Actionable suggestion." },
          category: {
            type: "STRING",
            description: "Focus area (Naming, SOLID, Security/Injection, etc.)",
          },
          priority: { type: "STRING", enum: ["low", "medium", "high"] },
          recommendedFix: {
            type: "OBJECT",
            description: "For HIGH-priority Security findings only.",
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
        required: [
          "file",
          "line",
          "snippet",
          "suggestion",
          "category",
          "priority",
        ],
      },
    },
  },
  required: ["namingConventionScore", "solidPrinciplesScore", "findings"],
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

const INFRA_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    findings: {
      type: "ARRAY",
      items: {
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
      },
    },
  },
  required: ["findings"],
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

interface IAiProviderOptions {
  accessToken: string;
  cloudProject: string;
  logDebug: (msg: string) => void;
}

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

/**
 * POST to a Code Assist method (e.g. `generateContent`, `loadCodeAssist`).
 * Automatically retries on 429 (rate limit) responses, waiting for the
 * server-suggested cooldown period before each retry.
 * Throws on non-2xx responses after retries are exhausted.
 */
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_SECONDS = [15, 30, 60];

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

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return res.json() as Promise<ApiResponse>;
    }

    const errText = await res.text();

    // Retry on 429 rate-limit errors
    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Try to parse "quota will reset after Ns" from the error body
      const match = errText.match(/reset after (\d+)s/);
      const waitSeconds = match
        ? parseInt(match[1], 10) + 2 // add 2s safety margin
        : (DEFAULT_BACKOFF_SECONDS[attempt] ?? 30);

      logDebug(
        `Rate limited (429). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES}...`,
      );
      await sleep(waitSeconds * 1000);
      continue;
    }

    throw new Error(`HTTP ${res.status} on ${method}: ${errText}`);
  }

  // Should not be reached, but satisfies TypeScript
  throw new Error(`Exhausted ${MAX_RETRIES} retries on ${method}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the text from the first candidate of a Code Assist generateContent
 * response.  Returns `"{}"` (safe default for JSON.parse callers) when the
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

  // ── IAiProvider.reviewCodeBatch ───────────────────────────────────────────

  async reviewCodeBatch(
    batch: CodeReviewBatch,
    context: { skillsContext?: string; feedbackSuffix?: string } = {},
  ): Promise<CodeBatchResult> {
    const systemPrompt = this.buildCodeReviewSystemPrompt(
      context.skillsContext ?? "",
      context.feedbackSuffix ?? "",
    );

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: batch.payload }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: CODE_REVIEW_RESPONSE_SCHEMA,
        },
      },
    };

    const estimatedTokens = Math.ceil(batch.payload.length / 4);
    this.logDebug(
      `reviewCodeBatch: ${batch.files.length} file(s), ~${estimatedTokens} tokens, model: ${GeminiModel.FLASH}`,
    );

    const json = await codeAssistPost(
      "generateContent",
      requestBody,
      this.accessToken,
      this.logDebug,
    );

    const responseText = extractResponseText(json);
    const parsed = JSON.parse(responseText) as Record<string, unknown>;

    const findings = this.extractFindings(parsed);
    const subScores = this.extractSubScores(parsed);

    return { findings, subScores };
  }

  // ── IAiProvider.shallowReviewFull ──────────────────────────────────────────

  async shallowReviewFull(payload: string): Promise<ShallowReviewResult> {
    const systemPrompt = this.buildShallowSystemPrompt();

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: payload }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: SHALLOW_REVIEW_SCHEMA,
        },
      },
    };

    const estimatedTokens = Math.ceil(payload.length / 4);
    this.logDebug(
      `shallowReviewFull: ~${estimatedTokens} tokens, model: ${GeminiModel.FLASH} (oneshot)`,
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
      codeDuplicationPercentage:
        typeof parsed["codeDuplicationPercentage"] === "number"
          ? (parsed["codeDuplicationPercentage"] as number)
          : 0,
      cyclomaticComplexity:
        typeof parsed["cyclomaticComplexity"] === "number"
          ? (parsed["cyclomaticComplexity"] as number)
          : 0,
      maintainabilityIndex:
        typeof parsed["maintainabilityIndex"] === "number"
          ? (parsed["maintainabilityIndex"] as number)
          : 50,
    };
  }

  // ── IAiProvider.deepReviewChunk ───────────────────────────────────────────

  async deepReviewChunk(
    batch: CodeReviewBatch,
    context: { skillsContext?: string; feedbackSuffix?: string } = {},
  ): Promise<CodeBatchResult> {
    const systemPrompt = this.buildDeepChunkSystemPrompt(
      context.skillsContext ?? "",
      context.feedbackSuffix ?? "",
    );

    const requestBody = {
      model: GeminiModel.FLASH,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: batch.payload }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: DEEP_CHUNK_REVIEW_SCHEMA,
        },
      },
    };

    const estimatedTokens = Math.ceil(batch.payload.length / 4);
    this.logDebug(
      `deepReviewChunk: ${batch.files.length} file(s), ~${estimatedTokens} tokens, model: ${GeminiModel.FLASH}`,
    );

    const json = await codeAssistPost(
      "generateContent",
      requestBody,
      this.accessToken,
      this.logDebug,
    );

    const responseText = extractResponseText(json);
    const parsed = JSON.parse(responseText) as Record<string, unknown>;

    const findings = this.extractFindings(parsed);
    const subScores: AiSubScores = {
      namingConventionScore:
        typeof parsed["namingConventionScore"] === "number"
          ? (parsed["namingConventionScore"] as number)
          : undefined,
      solidPrinciplesScore:
        typeof parsed["solidPrinciplesScore"] === "number"
          ? (parsed["solidPrinciplesScore"] as number)
          : undefined,
    };

    return { findings, subScores };
  }

  // ── IAiProvider.generateExecutiveSummary ─────────────────────────────────

  async generateExecutiveSummary(
    input: ExecutiveSummaryInput,
  ): Promise<ExecutiveSummary | undefined> {
    const prompt = this.buildExecutiveSummaryPrompt(input);

    const requestBody = {
      model: GeminiModel.PRO,
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

  // ── IAiProvider.auditInfrastructure ─────────────────────────────────────

  async auditInfrastructure(
    iacFiles: Record<string, string>,
    dependencyManifests: Record<string, string>,
  ): Promise<InfraFindingEntity[]> {
    if (
      Object.keys(iacFiles).length === 0 &&
      Object.keys(dependencyManifests).length === 0
    ) {
      this.logDebug("auditInfrastructure: no files provided, skipping.");
      return [];
    }

    const systemPrompt = this.buildInfraSystemPrompt();
    const userPrompt = this.buildInfraUserPrompt(iacFiles, dependencyManifests);

    const requestBody = {
      model: GeminiModel.PRO,
      project: this.cloudProject,
      request: {
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: INFRA_RESPONSE_SCHEMA,
        },
      },
    };

    this.logDebug(
      `auditInfrastructure: ${Object.keys(iacFiles).length} IaC + ${Object.keys(dependencyManifests).length} manifest(s).`,
    );

    try {
      const json = await codeAssistPost(
        "generateContent",
        requestBody,
        this.accessToken,
        this.logDebug,
      );
      const text = extractResponseText(json);
      const parsed = JSON.parse(text) as { findings?: InfraFindingEntity[] };
      return parsed?.findings ?? [];
    } catch (e: any) {
      this.logDebug(`auditInfrastructure failed: ${e.message}`);
      return [];
    }
  }

  // ── IAiProvider.generateSkills ───────────────────────────────────────────

  async generateSkills(prompt: string): Promise<Record<string, string>> {
    const requestBody = {
      model: GeminiModel.PRO,
      project: this.cloudProject,
      request: {
        systemInstruction: {
          role: "system",
          parts: [
            {
              text: "You are an expert software architect. Always respond with a single valid JSON object and nothing else.",
            },
          ],
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
      `generateSkills: model=${GeminiModel.PRO}, prompt=${prompt.length} chars`,
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
  // Private: Prompt builders (SRP — all prompt knowledge lives here)
  // ─────────────────────────────────────────────────────────────────────────

  private buildCodeReviewSystemPrompt(
    skillsContext: string,
    feedbackSuffix: string,
  ): string {
    return `You are an expert AI Security Researcher and code reviewer.
Review the code thoroughly for:
- Naming conventions and semantic names
- SOLID principles and design patterns
- Code benchmarks and performance optimization
- Logic and architectural correctness
- Security checks
- Dependency checks

## FINDING QUALITY GUIDELINES
- Be specific: flag real problems, not style opinions.
- Avoid filing the same structural observation (e.g., "logDebug duplication") as
  separate findings per file — file it once and name ALL affected files in the suggestion.
- Prefer fewer, high-quality findings over a long list of minor noise.

When finding issues, give a very small, specific 'snippet' (a few words or one statement)
so we can accurately locate it in the codebase.

Additional project context:
${skillsContext}${feedbackSuffix}`;
  }

  private buildShallowSystemPrompt(): string {
    return `You are an expert code analyst. Analyse the ENTIRE codebase provided and return ONLY global-level metrics.

Your task:
1. Estimate the percentage of duplicated / copy-pasted code across the whole project.
2. Estimate the average cyclomatic complexity of all functions.
3. Estimate the overall maintainability index (0–100, higher = more maintainable).

Do NOT list individual findings. Focus purely on the three numeric metrics.
Be precise and honest — do not round to convenient numbers.`;
  }

  private buildDeepChunkSystemPrompt(
    skillsContext: string,
    feedbackSuffix: string,
  ): string {
    return `You are an expert AI Security Researcher and code reviewer.
Review this code chunk thoroughly for:
- Naming conventions and semantic names
- SOLID principles and design patterns
- Security vulnerabilities (injection, XSS, auth bypass, etc.)
- Logic and architectural issues
- Performance anti-patterns

## FINDING QUALITY GUIDELINES
- Be specific: flag real problems, not style opinions.
- Prefer fewer, high-quality findings over a long list of minor noise.
- Give a very small, specific 'snippet' (a few words or one statement)
  so we can accurately locate it in the codebase.

Additional project context:
${skillsContext}${feedbackSuffix}`;
  }

  private buildExecutiveSummaryPrompt(input: ExecutiveSummaryInput): string {
    return `You are a senior software architect writing a concise executive summary for a code review.

Project scan results:
- Overall Score (Priority-Weighted): ${input.overallScore}/100
- ${input.totalCodeFindings} code finding(s), ${input.totalSecrets} secret(s) detected, ${input.totalInfraFindings} IaC/SCA issue(s)
- Internet-facing: ${input.isPublicFacing}
- Scanned files include: ${input.sampleFiles.join(", ")}

Top HIGH-priority code findings:
${input.topHighFindings.length > 0 ? input.topHighFindings.join("\n") : "None"}

Top infrastructure issues:
${input.topInfraFindings.length > 0 ? input.topInfraFindings.join("\n") : "None"}

Write exactly 3 paragraphs — no more, no less:
1. THE WHAT: What does this codebase appear to do? What is the general quality and technology stack?
2. THE IMPACT: What downstream effects could the top issues have on users, reliability, or other modules?
3. THE RISK: Summarise the top 1–3 security or architectural concerns that must be addressed before production.

Be concise, specific, and actionable. Do NOT use bullet points — use prose paragraphs.
Return a valid JSON object: { "what": "...", "impact": "...", "risk": "..." }`;
  }

  private buildInfraSystemPrompt(): string {
    return `You are an expert Cloud Security Engineer and DevSecOps architect.

Analyse the provided Infrastructure-as-Code (IaC) and dependency manifests for:

1. CONTAINER SECURITY (Dockerfile, docker-compose)
   - Running processes as root (missing USER directive)
   - Using 'latest' tags without digest pinning
   - Unnecessarily exposed ports
   - Secrets passed via ENV or ARG directives

2. TERRAFORM / IaC MISCONFIGURATIONS
   - Open S3 buckets (acl = "public-read" or "public-read-write")
   - Security groups with ingress 0.0.0.0/0 on sensitive ports
   - Hard-coded credentials or access keys
   - Missing encryption at rest / in transit

3. KUBERNETES / HELM
   - Pods running as root (missing securityContext)
   - Missing resource limits (CPU/memory)
   - Services of type LoadBalancer without access restrictions
   - Secrets stored in ConfigMaps

4. CI/CD PIPELINE SECURITY
   - Secrets printed to logs
   - Actions pinned to branch names instead of commit SHA
   - Excessive permissions (permissions: write-all)

5. DEPENDENCY REACHABILITY (SCA)
   - Dependencies with known CVEs or deprecated packages
   - Supply-chain incident packages

For each finding, reference the exact file name. Be specific and actionable.`;
  }

  private buildInfraUserPrompt(
    iacFiles: Record<string, string>,
    depFiles: Record<string, string>,
  ): string {
    const sections: string[] = [
      "Audit the following Infrastructure and dependency files:\n",
    ];
    for (const [name, content] of Object.entries(iacFiles)) {
      sections.push(`## IaC File: ${name}\n\`\`\`\n${content}\n\`\`\``);
    }
    for (const [name, content] of Object.entries(depFiles)) {
      sections.push(
        `## Dependency Manifest: ${name}\n\`\`\`\n${content}\n\`\`\``,
      );
    }
    return sections.join("\n\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Response parsers
  // ─────────────────────────────────────────────────────────────────────────

  private extractFindings(parsed: Record<string, unknown>): ReviewFinding[] {
    if (!Array.isArray(parsed["findings"])) return [];

    return (parsed["findings"] as Record<string, unknown>[])
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
