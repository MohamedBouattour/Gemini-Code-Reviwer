import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiProvider } from "../src/infrastructure/ai/GeminiProvider.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises");

describe("GeminiProvider", () => {
  let provider: GeminiProvider;
  const logDebug = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider("mock-token", "mock-project", logDebug);
    global.fetch = vi.fn();
    vi.useFakeTimers();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the Gemini API for a code review", async () => {
    const mockReviewResponse = {
      response: {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          score: 78,
          solidPrinciplesScore: 82,
          namingConventionScore: 90,
          maintainabilityIndex: 75,
          cyclomaticComplexity: 3.2,
          codeDuplicationPercentage: 8,
          codeFindings: [
            { file: "src/foo.ts", line: 10, snippet: "let x = 1", suggestion: "Use const", category: "CleanCode", priority: "low" }
          ]
        }) }] } }]
      }
    };

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockReviewResponse),
    } as Response);

    const result = await provider.reviewProject({
      codePayload: '<file path="src/foo.ts">\nlet x = 1;\n</file>',
    });

    expect(result.codeFindings).toHaveLength(1);
    expect(result.subScores.solidPrinciplesScore).toBe(82);
  });

  it("calls generateExecutiveSummary", async () => {
    const mockResponse = {
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({
        what: "A", impact: "B", risk: "C"
      }) }] } }] }
    };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    } as Response);

    const result = await provider.generateExecutiveSummary({
      overallScore: 80,
      totalCodeFindings: 5,
      totalSecrets: 0,
      totalInfraFindings: 1,
      isPublicFacing: true,
      sampleFiles: ["a.ts"],
      topHighFindings: ["High A"],
      topInfraFindings: ["Infra A"]
    });

    expect(result).toEqual({
      what: "A",
      impact: "B",
      risk: "C",
      isPublicFacing: true
    });
  });

  it("handles generateExecutiveSummary failure gracefully", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Error")
    } as Response);

    const result = await provider.generateExecutiveSummary({
      overallScore: 0,
      totalCodeFindings: 0,
      totalSecrets: 0,
      totalInfraFindings: 0,
      isPublicFacing: false,
      sampleFiles: [],
      topHighFindings: [],
      topInfraFindings: []
    });

    expect(result).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("generateExecutiveSummary failed"));
  });

  it("calls generateSkills", async () => {
    const mockResponse = {
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({
        "coding-standards": "Standard content",
        "testing-philosophy": "Test content",
        "ci-cd-requirements": "CI content",
        "architecture-patterns": "Arch content"
      }) }] } }] }
    };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    } as Response);

    const result = await provider.generateSkills("some prompt");
    expect(result["coding-standards"]).toBe("Standard content");
  });

  it("calls auditInfra", async () => {
    const mockResponse = {
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({
        files: [{ path: "p", extension: "e", lines: 1, bytes: 1, weight: 1, reason: "r", ignore_in_deep_review: false }],
        summary: { total_files: 1, total_lines: 1, high_impact_files: [], ignored_patterns_detected: [] }
      }) }] } }] }
    };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    } as Response);

    const result = await provider.auditInfra({
      infraFiles: {},
      packageJson: "{}",
      fileTree: []
    });

    expect(result.files).toHaveLength(1);
    expect(result.summary.total_files).toBe(1);
  });

  it("calls deepReview", async () => {
    const mockResponse = {
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({
        reviewed_files: [{ path: "p", overall_assessment: "ok", complexity_score: 1, issues: [] }],
        repo_level_findings: []
      }) }] } }] }
    };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    } as Response);

    const result = await provider.deepReview({
      fileContents: { "p": "content" },
      importContents: {},
      templateContents: {}
    });

    expect(result.reviewed_files).toHaveLength(1);
  });

  it("handles 429 rate limiting with retries", async () => {
    // 1st call: 429
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "5" }),
      text: () => Promise.resolve("Rate limited")
    } as Response);

    // 2nd call: Success
    const mockResponse = {
      response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 100, codeFindings: [], solidPrinciplesScore: 100, namingConventionScore: 100, maintainabilityIndex: 100, cyclomaticComplexity: 1, codeDuplicationPercentage: 0 }) }] } }] }
    };
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    } as Response);

    const reviewPromise = provider.reviewProject({ codePayload: "..." });

    // Wait slightly to let the first fetch execute and start sleeping
    await vi.advanceTimersByTimeAsync(0);
    // Fast forward for the 5s sleep
    await vi.advanceTimersByTimeAsync(6000);
    
    // Final wait to resolve the second fetch
    await vi.advanceTimersByTimeAsync(0);

    const result = await reviewPromise;
    expect(result.subScores.solidPrinciplesScore).toBe(100);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws HTTP 429", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: () => Promise.resolve("Still rate limited"),
    } as unknown as Response));

    const reviewPromise = provider.reviewProject({ codePayload: "..." });
    // Immediate catch to handle rejection within the same tick it occurs
    const caught = reviewPromise.catch(e => e);

    // Step through the 3 retry sleeps (MAX_RETRIES = 3)
    for (let i = 0; i < 3; i++) {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    }

    const err = await caught;
    expect(err.message).toContain("HTTP 429");
  });
});
