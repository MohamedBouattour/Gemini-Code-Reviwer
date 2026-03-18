import { describe, it, expect, vi } from "vitest";
import { CodeBenchmarkAuditor } from "../src/infrastructure/benchmark/CodeBenchmarkAuditor.js";
import type { CodeSegment } from "../src/core/entities/CodeSegment.js";
import type { AuditContext } from "../src/core/interfaces/IProjectAuditor.js";

describe("CodeBenchmarkAuditor and Analyzers", () => {
  const auditor = new CodeBenchmarkAuditor();

  it("should perform a full audit and return benchmarks", async () => {
    const codeFiles: CodeSegment[] = [
      {
        filePath: "src/UserService.ts",
        originalContent: `
          class UserService {
            getUser(id: string) {
              if (id) {
                return id;
              }
              return null;
            }
          }
        `,
        content: "ignore",
      },
      {
        filePath: "src/duplicate.ts",
        originalContent: `
          function a() {
            console.log("line 1");
            console.log("line 2");
            console.log("line 3");
            console.log("line 4");
            console.log("line 5");
            console.log("line 6");
          }
          function b() {
            console.log("line 1");
            console.log("line 2");
            console.log("line 3");
            console.log("line 4");
            console.log("line 5");
            console.log("line 6");
          }
        `,
        content: "ignore",
      }
    ];

    const context: AuditContext = {
      codeFiles,
      iacFiles: {},
      dependencyManifests: {},
      isPublicFacing: false,
      logDebug: vi.fn(),
    };

    const result = await auditor.audit(context);

    expect(result.benchmarks).toBeDefined();
    expect(result.benchmarkScores).toBeDefined();
    expect(result.scannedFiles).toHaveLength(2);
    
    // Check complexity
    expect(result.benchmarks?.complexity.totalFunctions).toBeGreaterThan(0);
    
    // Check duplication
    expect(result.benchmarks?.duplication.duplicationPercentage).toBeGreaterThan(0);
    
    // Check naming
    expect(result.benchmarks?.naming.totalChecked).toBeGreaterThan(0);
  });

  it("should flag complexity hotspots", async () => {
    const codeFiles: CodeSegment[] = [{
      filePath: "src/complex.ts",
      originalContent: `
        function veryComplex() {
          if (a) {}
          if (b) {}
          if (c) {}
          if (d) {}
          if (e) {}
          if (f) {}
          if (g) {}
          if (h) {}
          if (i) {}
          if (j) {}
          if (k) {}
        }
      `,
      content: "",
    }];

    const result = await auditor.audit({ codeFiles } as unknown as AuditContext);
    const complexFinding = result.codeFindings?.find(f => f.category === "Complexity");
    expect(complexFinding).toBeDefined();
    expect(complexFinding?.priority).toBe("medium"); // CC = 11, so > 10
  });

  it("should flag naming violations", async () => {
    const codeFiles: CodeSegment[] = [{
      filePath: "src/bad_naming.ts", // not kebab or pascal
      originalContent: `
        class badNaming {}
        interface iUser {}
        type my_type = string;
        enum my_enum { A }
        function BadFunc() {}
        let BadVar = 1;
        const bad_const = 2;
        const GOOD_CONST = 3;
      `,
      content: "",
    }];

    const result = await auditor.audit({ codeFiles } as unknown as AuditContext);
    const namingFindings = result.codeFindings?.filter(f => f.category === "Naming");
    
    expect(namingFindings?.some(f => f.snippet === "badNaming")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "iUser")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "my_type")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "my_enum")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "BadFunc")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "BadVar")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "bad_const")).toBe(true);
    expect(namingFindings?.some(f => f.snippet === "GOOD_CONST")).toBe(false);
  });

  it("should handle empty file set", async () => {
    const result = await auditor.audit({ codeFiles: [] } as unknown as AuditContext);
    expect(result.benchmarks?.complexity.totalFunctions).toBe(0);
    expect(result.benchmarks?.duplication.duplicationPercentage).toBe(0);
  });
});
