import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../src/infrastructure/ai/GeminiProvider.js";

describe("GeminiProvider", () => {
  let provider: any;

  beforeEach(() => {
    // constructor(accessToken, cloudProject, logDebug)
    provider = new GeminiProvider("mock-token", "mock-project", vi.fn());

    // Mock global fetch
    global.fetch = vi.fn() as any;
  });

  it("calls the Gemini API for a code review", async () => {
    const mockReviewResponse = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    score: 78,
                    solidPrinciplesScore: 82,
                    namingConventionScore: 90,
                    maintainabilityIndex: 75,
                    cyclomaticComplexity: 3.2,
                    codeDuplicationPercentage: 8,
                    codeFindings: [
                      {
                        file: "src/foo.ts",
                        line: 10,
                        snippet: "let x = 1",
                        suggestion: "Use const instead of let",
                        category: "CleanCode",
                        priority: "low",
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      },
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockReviewResponse),
    });

    const result = await provider.reviewProject({
      codePayload: '<file path="src/foo.ts">\nlet x = 1;\n</file>',
      skillsContext: "",
      feedbackSuffix: "",
    });

    expect(result.codeFindings).toHaveLength(1);
    expect(result.codeFindings[0].file).toBe("src/foo.ts");
    expect(result.subScores.solidPrinciplesScore).toBe(82);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generateContent"),
      expect.anything(),
    );
  });

  it("calls the Gemini API for an infrastructure audit", async () => {
    const mockInfraResponse = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    infraFindings: [
                      {
                        file: "Dockerfile",
                        category: "misconfiguration",
                        title: "Run as root",
                        description: "Container runs as root",
                        remediation: "Add USER directive",
                        severity: "high",
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      },
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockInfraResponse),
    });

    const result = await provider.reviewInfrastructure({
      iacFiles: { Dockerfile: "FROM node:18" },
      dependencyManifests: {},
      projectTree: "Dockerfile",
    });

    expect(result.infraFindings).toHaveLength(1);
    expect(result.infraFindings[0].title).toBe("Run as root");
  });

  it("handles API errors gracefully", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("Error details"),
    });

    await expect(
      provider.reviewProject({
        codePayload: "let x = 1;",
      }),
    ).rejects.toThrow("HTTP 500");
  });
});
