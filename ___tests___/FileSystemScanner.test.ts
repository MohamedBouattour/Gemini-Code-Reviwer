import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileSystemScanner, optimizeContent } from "../src/infrastructure/filesystem/FileSystemScanner.js";
import fs from "fs/promises";
import fg from "fast-glob";

vi.mock("fs/promises");
vi.mock("fast-glob");

describe("FileSystemScanner", () => {
  const scanner = new FileSystemScanner();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("optimizeContent", () => {
    it("normalizes carriage returns", () => {
      const input = "line1\r\nline2";
      expect(optimizeContent("test.ts", input)).toBe("line1 line2");
    });

    it("strips SVG inner paths", () => {
      const input = "<svg><path d='...'/></svg>";
      expect(optimizeContent("test.html", input)).toBe("<svg></svg>");
    });

    it("removes JS/TS imports", () => {
      const input = "import { x } from 'y';\nimport 'z';\nconst a = 1;";
      const result = optimizeContent("test.ts", input);
      expect(result).toBe("const a = 1;");
    });

    it("collapses multiple spaces and trims", () => {
      const input = "   const    a    =    1;   ";
      expect(optimizeContent("test.ts", input)).toBe("const a = 1;");
    });
  });

  describe("scan", () => {
    it("scans files and returns project structure", async () => {
      const baseDir = "/test";
      vi.mocked(fg).mockResolvedValue(["/test/src/a.ts", "/test/src/b.java"] as any);
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path.toString().endsWith(".gitignore")) return "";
        if (path.toString().endsWith("a.ts")) return "class A {}";
        if (path.toString().endsWith("b.java")) return "class B {}";
        return "";
      });

      const result = await scanner.scan(baseDir);

      expect(result.codeFiles).toHaveLength(2);
      expect(result.codeFiles[0].filePath.replace(/\\/g, "/")).toBe("src/a.ts");
      expect(result.codeFiles[0].originalContent).toBe("class A {}");
      expect(result.codeFiles[1].filePath.replace(/\\/g, "/")).toBe("src/b.java");
    });

    it("handles .gitignore patterns", async () => {
      const baseDir = "/test";
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path.toString().endsWith(".gitignore")) {
          return "node_modules\n/dist\n# comment\n";
        }
        return "";
      });
      vi.mocked(fg).mockResolvedValue([]);

      await scanner.scan(baseDir);

      expect(fg).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ignore: expect.arrayContaining(["**/node_modules", "dist/**"])
        })
      );
    });

    it("handles file read errors gracefully", async () => {
      const baseDir = "/test";
      vi.mocked(fg).mockResolvedValue(["/test/src/error.ts"] as any);
      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        if (path.toString().endsWith(".gitignore")) return "";
        throw new Error("Read fail");
      });

      const result = await scanner.scan(baseDir);

      expect(result.codeFiles).toHaveLength(0);
    });
  });
});
