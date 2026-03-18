import { describe, it, expect, vi, beforeEach, type Mocked } from "vitest";
import { RunCodeReview } from "../src/application/RunCodeReview.js";
import * as fs from "node:fs/promises";
import crypto from "node:crypto";
import type { IFileScanner } from "../src/core/interfaces/IFileScanner.js";
import type { IAiProvider } from "../src/core/interfaces/IAiProvider.js";
import type { IProjectAuditor } from "../src/core/interfaces/IProjectAuditor.js";
import type { ISkillRepository } from "../src/core/interfaces/ISkillRepository.js";
import type { IReportBuilder } from "../src/core/interfaces/IReportBuilder.js";
import type { IFeedbackManager } from "../src/application/RunCodeReview.js";

// Mock the node fs to prevent actual file writes during tests
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

describe("RunCodeReview", () => {
  let mockScanner: Mocked<IFileScanner>;
  let mockAiProvider: Mocked<IAiProvider>;
  let mockAuditor: Mocked<IProjectAuditor>;
  let mockSkillRepo: Mocked<ISkillRepository>;
  let mockReportBuilder: Mocked<IReportBuilder>;
  let mockFeedbackManager: Mocked<IFeedbackManager>;
  let runCodeReview: RunCodeReview;

  beforeEach(() => {
    mockScanner = {
      scan: vi.fn(),
    } as unknown as Mocked<IFileScanner>;

    mockAiProvider = {
      auditInfra: vi.fn(),
      deepReview: vi.fn(),
      generateExecutiveSummary: vi.fn(),
      reviewProject: vi.fn(), // Required by interface
      reviewInfrastructure: vi.fn(), // Required by interface
      generateSkills: vi.fn(), // Required by interface
    } as unknown as Mocked<IAiProvider>;

    mockAuditor = {
      name: "Mock Auditor",
      audit: vi.fn(),
    } as unknown as Mocked<IProjectAuditor>;

    mockSkillRepo = {
      loadSkillsContext: vi.fn(),
    } as unknown as Mocked<ISkillRepository>;

    mockReportBuilder = {
      addAiFindings: vi.fn(),
      addSecretResults: vi.fn(),
      addInfrastructureResults: vi.fn(),
      setAiScores: vi.fn(),
      setExecutiveSummary: vi.fn(),
      setTimingStats: vi.fn(),
      calculateFinalScore: vi.fn(),
      build: vi.fn(),
      setLocalBenchmarks: vi.fn(),
    } as unknown as Mocked<IReportBuilder>;

    mockFeedbackManager = {
      buildSystemPromptSuffix: vi.fn().mockReturnValue(""),
      hasFeedback: false,
      isFalsePositive: vi.fn().mockReturnValue(false),
    } as unknown as Mocked<IFeedbackManager>;

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
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));

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
      // Verify orchestration: auditor was called and summary was generated
      expect(mockAuditor.audit).toHaveBeenCalledTimes(1);
      expect(mockAiProvider.generateExecutiveSummary).toHaveBeenCalledTimes(1);
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

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cacheState));
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
      // Should NOT call auditor for unchanged files
      expect(mockAuditor.audit).not.toHaveBeenCalled();
    });

    it("makes exactly one AI call per type for changed file set", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("No cache"));

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
      mockAiProvider.generateExecutiveSummary.mockResolvedValue({
        what: "summary",
        impact: "impact",
        risk: "risk",
        isPublicFacing: false,
      });
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

      // Verify orchestration
      expect(mockAuditor.audit).toHaveBeenCalledTimes(1);
      expect(mockAiProvider.generateExecutiveSummary).toHaveBeenCalledTimes(1);
    });

    it("resolves line numbers correctly for complex snippets", async () => {
      mockScanner.scan.mockResolvedValue({
        codeFiles: [
          {
            filePath: "src/algo.ts",
            originalContent: "line1\nline2\n  line3   \nline4",
            content: "line1\nline2\n  line3   \nline4",
          } as any,
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

      mockAuditor.audit.mockResolvedValue({
        codeFindings: [
          {
            file: "src/algo.ts",
            snippet: "  line3   ",
            suggestion: "fix",
            type: "SECURITY",
            severity: "HIGH",
          } as any,
        ],
        secretFindings: [],
        infraFindings: [],
      });

      vi.mocked(fs.readFile).mockRejectedValue(new Error());

      const result = await runCodeReview.execute({
        baseDir: "test-dir",
        logDebug: () => {},
      });

      expect(result.report.codeFindings[0].line).toBe(3);
    });

    it("applies risk multipliers based on file path", async () => {
      mockScanner.scan.mockResolvedValue({
        codeFiles: [
          { filePath: "src/api/handler.ts", originalContent: "x", content: "x" } as any,
          { filePath: "__tests__/logic.test.ts", originalContent: "x", content: "x" } as any,
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

      mockAuditor.audit.mockResolvedValue({
        codeFindings: [
          { file: "src/api/handler.ts", snippet: "x", suggestion: "s", type: "SECURITY", severity: "HIGH" } as any,
          { file: "__tests__/logic.test.ts", snippet: "x", suggestion: "s", type: "SECURITY", severity: "HIGH" } as any,
        ],
        secretFindings: [],
        infraFindings: [],
      });

      vi.mocked(fs.readFile).mockRejectedValue(new Error());
      const result = await runCodeReview.execute({ baseDir: ".", logDebug: () => {} });

      const apiFinding = result.report.codeFindings.find(f => f.file.includes("api"));
      const testFinding = result.report.codeFindings.find(f => f.file.includes("test"));

      expect(apiFinding?.riskMultiplier).toBe(2.0);
      expect(testFinding?.riskMultiplier).toBe(0.3);
    });
  });
});
