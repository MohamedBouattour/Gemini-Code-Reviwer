import { describe, it, expect, vi } from "vitest";
import { optimizeContent } from "../src/infrastructure/filesystem/FileSystemScanner.js";

describe("FileSystemScanner - optimizeContent", () => {
  it("normalizes carriage returns", () => {
    const input = "line1\r\nline2";
    expect(optimizeContent(input)).toBe("line1 line2"); // optimizeContent collapses whitespace to space
  });

  it("strips SVG inner paths", () => {
    const input = "<svg><path d='...'/></svg>";
    // optimizeContent replaces <svg...>(.*?)</svg> with <svg...></svg>
    expect(optimizeContent(input)).toBe("<svg></svg>");
  });

  it("removes multi-line comments", () => {
    const input = "const a = 1; /* comment */ const b = 2;";
    expect(optimizeContent(input)).toBe("const a = 1; const b = 2;");
  });

  it("removes single-line comments but preserves URLs", () => {
    const input =
      "// comment\nconst url = 'https://google.com'; // another comment";
    // optimizeContent removes //... but not if prefixed by http: or https:
    const result = optimizeContent(input);
    expect(result).toContain("https://google.com");
    expect(result).not.toContain("comment");
  });

  it("removes JS/TS imports", () => {
    const input = "import { x } from 'y';\nimport 'z';\nconst a = 1;";
    const result = optimizeContent(input);
    expect(result).toBe("const a = 1;");
  });

  it("removes Java imports", () => {
    const input = "import java.util.List;\nimport static x.y.z;\nclass A {}";
    const result = optimizeContent(input);
    expect(result).toBe("class A {}");
  });

  it("collapses multiple spaces and trims", () => {
    const input = "   const    a    =    1;   ";
    expect(optimizeContent(input)).toBe("const a = 1;");
  });
});
