import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunCodeReview } from "../src/application/RunCodeReview.js";
import * as fs from "node:fs/promises";
import crypto from "node:crypto";

// Mock the node fs to prevent actual file writes during tests
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

describe("RunCodeReview", () => {
  let mockScanner: any;
  let mockAiProvider: any;
  let mockAuditor: any;
  let mockSkillRepo: any;
  let mockReportBuilder: any;
  let mockFeedbackManager: any;
  let runCodeReview: any;

  beforeEach(() => {
    mockScanner = {
      scan: vi.fn().mockResolvedValue({
        codeFiles: [
          {
            filePath: "src/index.ts",
            originalContent: "const a = 1;",
            content: "const a = 1;",
          },
        ],
        iacFiles: {},
        dependencyManifests: {},
        configFiles: {},
        ciFiles: {},
        sampleSources: [],
        sampleTests: [],
        directoryTree: "",
        isPublicFacing: false,
      }),
    };

    mockAiProvider = {
      reviewProject: vi.fn().mockResolvedValue({
        codeFindings: [
          {
            priority: "high",
            file: "src/index.ts",
            line: 1,
            snippet: "const",
            suggestion: "no const",
          },
        ],
        subScores: {
          namingConventionScore: 85,
          solidPrinciplesScore: 80,
          codeDuplicationPercentage: 5,
          cyclomaticComplexity: 3,
          maintainabilityIndex: 78,
        },
      }),
      reviewInfrastructure: vi.fn().mockResolvedValue({
        infraFindings: [],
      }),
      generateExecutiveSummary: vi.fn().mockResolvedValue({
        what: "A",
        impact: "B",
        risk: "C",
        isPublicFacing: false,
      }),
    };

    mockAuditor = {
      name: "Mock Auditor",
      audit: vi.fn().mockResolvedValue({
        secretFindings: [],
        infraFindings: [],
      }),
    };

    mockSkillRepo = {
      loadSkillsContext: vi.fn().mockResolvedValue("Skills context"),
    };

    mockReportBuilder = {
      addAiFindings: vi.fn(),
      addSecretResults: vi.fn(),
      addInfrastructureResults: vi.fn(),
      setAiScores: vi.fn(),
      setExecutiveSummary: vi.fn(),
      setTimingStats: vi.fn(),
      calculateFinalScore: vi.fn().mockReturnValue(85),
      build: vi.fn().mockReturnValue("# Report"),
    };

    mockFeedbackManager = {
      buildSystemPromptSuffix: vi.fn().mockReturnValue(""),
      hasFeedback: false,
      isFalsePositive: vi.fn().mockReturnValue(false),
    };

    runCodeReview = new RunCodeReview(
      mockScanner,
      mockAiProvider,
      [mockAuditor],
      mockSkillRepo,
      mockReportBuilder,
      mockFeedbackManager,
    );

    vi.clearAllMocks();
  });

  describe("execute()", () => {
    it("runs the split review pipeline successfully", async () => {
      (fs.readFile as any).mockRejectedValue(new Error("File not found"));

      // Re-bind mocks after clearAllMocks
      mockScanner.scan.mockResolvedValue({
        codeFiles: [
          {
            filePath: "src/index.ts",
            originalContent: "const a = 1;",
            content: "const a = 1;",
          },
        ],
        iacFiles: {},
        dependencyManifests: {},
        configFiles: {},
        ciFiles: {},
        sampleSources: [],
        sampleTests: [],
        directoryTree: "",
        isPublicFacing: false,
      });
      mockAiProvider.reviewProject.mockResolvedValue({
        codeFindings: [],
        subScores: {},
      });
      mockAiProvider.reviewInfrastructure.mockResolvedValue({
        infraFindings: [],
      });
      mockAiProvider.generateExecutiveSummary.mockResolvedValue({
        what: "A",
        impact: "B",
        risk: "C",
        isPublicFacing: false,
      });
      mockSkillRepo.loadSkillsContext.mockResolvedValue("Skills context");
      mockAuditor.audit.mockResolvedValue({
        secretFindings: [],
        infraFindings: [],
      });
      mockFeedbackManager.buildSystemPromptSuffix.mockReturnValue("");
      mockFeedbackManager.isFalsePositive.mockReturnValue(false);
      mockReportBuilder.calculateFinalScore.mockReturnValue(85);

      const result = await runCodeReview.execute({
        baseDir: "test-dir",
        onProgress: () => {},
        logDebug: () => {},
      });

      expect(result.report).toBeDefined();
      // Split AI call — one for code, one for infra
      expect(mockAiProvider.reviewProject).toHaveBeenCalledTimes(1);
      expect(mockAiProvider.reviewInfrastructure).toHaveBeenCalledTimes(1);
    });

    it("returns cached report without calling AI if no files changed", async () => {
      const codeContent = "const a = 1;";
      const hash = crypto
        .createHash("sha256")
        .update(codeContent)
        .digest("hex");

      const cacheState = {
        fileHashes: { "src/index.ts": hash },
        findings: [
          {
            file: "src/index.ts",
            line: 1,
            snippet: "test",
            suggestion: "test",
            priority: "low",
          },
        ],
        namingConventionScore: 8,
        solidPrinciplesScore: 8,
        codeDuplicationPercentage: 1,
        cyclomaticComplexity: 2,
        maintainabilityIndex: 100,
      };

      (fs.readFile as any).mockResolvedValue(JSON.stringify(cacheState));
      mockScanner.scan.mockResolvedValue({
        codeFiles: [
          {
            filePath: "src/index.ts",
            originalContent: codeContent,
            content: codeContent,
          },
        ],
        iacFiles: {},
        dependencyManifests: {},
        configFiles: {},
        ciFiles: {},
        sampleSources: [],
        sampleTests: [],
        directoryTree: "",
        isPublicFacing: false,
      });

      const result = await runCodeReview.execute({
        baseDir: "test-dir",
        onProgress: () => {},
        logDebug: () => {},
      });

      expect(result.report.fileHashes["src/index.ts"]).toBe(hash);
      // Should NOT call AI for unchanged files
      expect(mockAiProvider.reviewProject).not.toHaveBeenCalled();
    });

    it("makes exactly one AI call per type for changed file set", async () => {
      (fs.readFile as any).mockRejectedValue(new Error("No cache"));

      mockScanner.scan.mockResolvedValue({
        codeFiles: [
          { filePath: "src/a.ts", content: "A", originalContent: "A" },
          { filePath: "src/b.ts", content: "B", originalContent: "B" },
        ],
        iacFiles: {},
        dependencyManifests: {},
        configFiles: {},
        ciFiles: {},
        sampleSources: [],
        sampleTests: [],
        directoryTree: "",
        isPublicFacing: false,
      });
      mockAiProvider.reviewProject.mockResolvedValue({
        codeFindings: [],
        subScores: {},
      });
      mockAiProvider.reviewInfrastructure.mockResolvedValue({
        infraFindings: [],
      });
      mockAiProvider.generateExecutiveSummary.mockResolvedValue(undefined);
      mockSkillRepo.loadSkillsContext.mockResolvedValue("");
      mockAuditor.audit.mockResolvedValue({
        secretFindings: [],
        infraFindings: [],
      });
      mockFeedbackManager.buildSystemPromptSuffix.mockReturnValue("");
      mockFeedbackManager.isFalsePositive.mockReturnValue(false);
      mockReportBuilder.calculateFinalScore.mockReturnValue(90);

      await runCodeReview.execute({
        baseDir: "test-dir",
        onProgress: () => {},
        logDebug: () => {},
      });

      // Split AI calls
      expect(mockAiProvider.reviewProject).toHaveBeenCalledTimes(1);
      expect(mockAiProvider.reviewInfrastructure).toHaveBeenCalledTimes(1);
    });
  });
});
