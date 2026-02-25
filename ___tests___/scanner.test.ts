import { describe, it, expect } from "vitest";
import {
  optimizeContent,
  findLineNumberToMatchSnippet,
} from "../src/scanner.js";

describe("scanner - optimizeContent", () => {
  it("normalizes carriage returns and squashes them", () => {
    const input = "line1\r\nline2\r\nline3";
    const optimized = optimizeContent(input);
    expect(optimized).toBe("line1 line2 line3");
  });

  it("strips inner paths from SVG elements and strips empty lines", () => {
    const input = `<svg viewBox="0 0 24 24">\n  <path d="M10 10 H 90 V 90 H 10 Z" />\n</svg>`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe('<svg viewBox="0 0 24 24"></svg>');
  });

  it("removes multi-line comments and strips resulting blank lines", () => {
    const input = `function foo() {\n  /*\n   * This is a comment\n   */\n  return true;\n}`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("function foo() { return true; }");
  });

  it("removes single-line comments", () => {
    const input = `const a = 1; // this is a variable\nconst b = 2; // another one`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("const a = 1; const b = 2;");
  });

  it("does not remove http:// or https:// in strings", () => {
    const input = `const url = "https://example.com";\nconst url2 = 'http://test.com';`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe(
      `const url = "https://example.com"; const url2 = 'http://test.com';`,
    );
  });

  it("removes JS/TS multi-line imports completely", () => {
    const input = `import {\n  ModuleA,\n  ModuleB\n} from 'my-module';\n\nconst a = 1;`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("const a = 1;");
  });

  it("removes JS/TS single-line imports", () => {
    const input = `import { Something } from "somewhere";\nconst a = 1;`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("const a = 1;");
  });

  it("removes basic imports", () => {
    const input = `import 'polyfills';\nconst a = 1;`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("const a = 1;");
  });

  it("removes Java imports", () => {
    const input = `import java.util.List;\nimport static org.junit.Assert.*;\n\npublic class Test {}`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("public class Test {}");
  });

  it("trims indentation and removes blank lines", () => {
    const input = `function test() {\n    const a = 1;\n\n    return a;\n}`;
    const optimized = optimizeContent(input);
    expect(optimized).toBe("function test() { const a = 1; return a; }");
  });

  it("handles a complex mixed file correctly", () => {
    const input = [
      "import {",
      "  foo",
      "} from 'bar';",
      "",
      "/* Block comment",
      "   spanning lines */",
      "function doSomething() {",
      "  // inline comment",
      "  const x = 1;",
      "  return x;",
      "}",
    ].join("\n");

    const optimized = optimizeContent(input);
    expect(optimized).toBe("function doSomething() { const x = 1; return x; }");
  });
});

describe("scanner - findLineNumberToMatchSnippet", () => {
  it("finds the correct line for a single-line snippet", () => {
    const originalContent = "a\nb\nc\nconst x = 1;\nd";
    const snippet = "const x = 1;";
    const line = findLineNumberToMatchSnippet(originalContent, snippet);
    expect(line).toBe(4);
  });

  it("finds the correct line for a multi-line snippet", () => {
    const originalContent = "function foo() {\n  return 1;\n}\n\nconst a = 1;";
    const snippet = "function foo() {\n  return 1;\n}";
    const line = findLineNumberToMatchSnippet(originalContent, snippet);
    expect(line).toBe(1);
  });

  it("finds the correct line ignoring formatting and whitespace differences", () => {
    const originalContent = "  const \n  x = \n  1;";
    const snippet = "const x = 1;";
    const line = findLineNumberToMatchSnippet(originalContent, snippet);
    expect(line).toBe(1);
  });

  it("returns 1 if snippet not found", () => {
    const originalContent = "line 1\nline 2";
    const snippet = "does not exist";
    const line = findLineNumberToMatchSnippet(originalContent, snippet);
    expect(line).toBe(1);
  });
});
