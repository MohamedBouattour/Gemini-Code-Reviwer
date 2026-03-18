import { describe, it, expect, vi, beforeEach, type Mocked } from "vitest";
import { InfraAuditorAdapter } from "../src/infrastructure/security/InfraAuditorAdapter.js";
import type { IAiProvider, InfraAuditResult, DeepReviewResult } from "../src/core/interfaces/IAiProvider.js";
import type { AuditContext } from "../src/core/interfaces/IProjectAuditor.js";

describe("InfraAuditorAdapter", () => {
  let mockAiProvider: Mocked<IAiProvider>;
  let adapter: InfraAuditorAdapter;

  beforeEach(() => {
    mockAiProvider = {
      auditInfra: vi.fn(),
      deepReview: vi.fn(),
      reviewProject: vi.fn(),
      reviewInfrastructure: vi.fn(),
      generateExecutiveSummary: vi.fn(),
      generateSkills: vi.fn(),
    } as unknown as Mocked<IAiProvider>;

    adapter = new InfraAuditorAdapter(mockAiProvider);
    vi.clearAllMocks();
  });

  const createMockContext = (overrides = {}): AuditContext => ({
    codeFiles: [
      { filePath: "src/important.ts", originalContent: "code", content: "code" },
      { filePath: "src/unimportant.ts", originalContent: "junk", content: "junk" },
    ],
    iacFiles: { "Dockerfile": "FROM node" },
    dependencyManifests: { "package.json": "{}" },
    isPublicFacing: false,
    logDebug: vi.fn(),
    ...overrides
  });

  it("should perform sequential AI calls: auditInfra then deepReview", async () => {
    const context = createMockContext();

    const mockAuditResult: InfraAuditResult = {
      files: [
        { 
          path: "src/important.ts", 
          weight: 90, 
          ignore_in_deep_review: false,
          reason: "critical",
          extension: "ts",
          bytes: 100,
          lines: 5
        },
        { 
          path: "src/unimportant.ts", 
          weight: 10, 
          ignore_in_deep_review: false,
          reason: "minor",
          extension: "ts",
          bytes: 50,
          lines: 2
        },
      ],
      summary: { 
        total_files: 2,
        total_lines: 7,
        high_impact_files: ["src/important.ts"],
        ignored_patterns_detected: ["node_modules"] 
      },
    };

    const mockDeepResult: DeepReviewResult = {
      reviewed_files: [
        {
          path: "src/important.ts",
          overall_assessment: "Acceptable",
          complexity_score: 5,
          issues: [
            { 
              type: "SECURITY", 
              severity: "HIGH", 
              evidence: "fix this", 
              suggested_fix: "fixed",
              description: "vulnerability"
            },
          ],
        },
      ],
      repo_level_findings: [],
    };

    mockAiProvider.auditInfra.mockResolvedValue(mockAuditResult);
    mockAiProvider.deepReview.mockResolvedValue(mockDeepResult);

    const result = await adapter.audit(context);

    expect(mockAiProvider.auditInfra).toHaveBeenCalled();
    expect(mockAiProvider.deepReview).toHaveBeenCalledWith(expect.objectContaining({
      fileContents: { "src/important.ts": "code" }
    }));
    
    expect(result.codeFindings).toBeDefined();
    if (result.codeFindings) {
      expect(result.codeFindings).toHaveLength(1);
      expect(result.codeFindings[0].file).toBe("src/important.ts");
    }
  });

  it("should skip deep review if no files are above threshold", async () => {
    const context = createMockContext({
      codeFiles: [{ filePath: "low.ts", originalContent: "code", content: "code" }]
    });

    mockAiProvider.auditInfra.mockResolvedValue({
      files: [{ 
        path: "low.ts", 
        weight: 10, 
        ignore_in_deep_review: false,
        reason: "low",
        extension: "ts",
        bytes: 10,
        lines: 1
      }],
      summary: { 
        total_files: 1, 
        total_lines: 1, 
        high_impact_files: [], 
        ignored_patterns_detected: [] 
      },
    });

    const result = await adapter.audit(context);

    expect(mockAiProvider.auditInfra).toHaveBeenCalled();
    expect(mockAiProvider.deepReview).not.toHaveBeenCalled();
    expect(result.codeFindings).toHaveLength(0);
  });
});
