import { describe, it, expect } from "vitest";
import { StaticSecurityAuditor } from "../src/infrastructure/security/StaticSecurityAuditor.js";

function createContext(content: string, filePath: string = "test.ts"): any {
  return {
    codeFiles: [
      {
        filePath,
        content: content,
        originalContent: content,
      },
    ],
    iacFiles: {},
    dependencyManifests: {},
    isPublicFacing: false,
  };
}

describe("StaticSecurityAuditor", () => {
  const auditor: any = new StaticSecurityAuditor();

  describe("Regex scanning", () => {
    it("detects AWS Access Keys", async () => {
      const code = `const awsKey = "AKIA1234567890ABCDEF";`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(result.secretFindings.length).toBeGreaterThan(0);
      expect(result.secretFindings[0].patternType).toBe("aws-access-key");
    });

    it("detects generic API keys", async () => {
      const code = `const apiKey = "12345ABCDEXXXXXXXXXXXXXX";`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(
        result.secretFindings.some(
          (f: any) => f.patternType === "generic-api-key",
        ),
      ).toBe(true);
    });

    it("detects hardcoded passwords", async () => {
      const code = `const password = "mysecretpassword123";`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(
        result.secretFindings.some(
          (f: any) => f.patternType === "hardcoded-password",
        ),
      ).toBe(true);
    });

    it("ignores dynamic secrets like process.env", async () => {
      const code = `const password = process.env.DB_PASSWORD;`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(
        result.secretFindings.some(
          (f: any) => f.patternType === "hardcoded-password",
        ),
      ).toBe(false);
    });
  });

  describe("Shannon Entropy scanning", () => {
    it("ignores low entropy strings", async () => {
      const code = `const greeting = "Hello, world! This is a simple phrase.";`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(
        result.secretFindings.some(
          (f: any) => f.patternType === "high-entropy-string",
        ),
      ).toBe(false);
    });

    it("detects high entropy random strings", async () => {
      const randomCode = `const randomGibberish = "zQY1s$9mP#tR@kL4xW^nB8vC%fG&hJ2*dF!xO~pZ(yT)bM_qE+aU=";`;
      const randomContext = createContext(randomCode);
      const randomResult = await auditor.audit(randomContext);

      expect(
        randomResult.secretFindings.some(
          (f: any) => f.patternType === "high-entropy-string",
        ),
      ).toBe(true);
    });

    it("ignores URLs and import paths", async () => {
      const code = `import { S } from "@some/long/package";\nconst url = "https://example.com/very/long/random/url";`;
      const context = createContext(code);
      const result = await auditor.audit(context);

      expect(
        result.secretFindings.some(
          (f: any) => f.patternType === "high-entropy-string",
        ),
      ).toBe(false);
    });
  });

  describe("Sorting logic", () => {
    it("sorts by severity (critical first) then by file and line", async () => {
      const codeFiles: any[] = [
        {
          filePath: "b.ts",
          originalContent: `const pwd = "p-hardcoded-123";`, // hardcoded-password is critical
        },
        {
          filePath: "a.ts",
          originalContent: `const pwd = "p-hardcoded-456";\nconst aws = "AKIA1234567890ABCDEF";`,
        },
      ];

      const context: any = {
        codeFiles,
        iacFiles: {},
        dependencyManifests: {},
        isPublicFacing: false,
      };
      const result = await auditor.audit(context);

      // Should be:
      // 1. a.ts: line 1 (password - critical)
      // 2. a.ts: line 2 (aws - critical)
      // 3. b.ts: line 1 (password - critical)
      // (Actually all are critical in my current rules)

      expect(result.secretFindings[0].file).toBe("a.ts");
      expect(result.secretFindings[0].line).toBe(1);
      expect(result.secretFindings[1].file).toBe("a.ts");
      expect(result.secretFindings[1].line).toBe(2);
      expect(result.secretFindings[2].file).toBe("b.ts");
    });
  });
});
