import { describe, it, expect } from "vitest";
import { TypeScriptStrategy } from "../src/infrastructure/analysis/languages/TypeScriptStrategy.js";

describe("TypeScriptStrategy", () => {
  const strategy = new TypeScriptStrategy();

  describe("extractFunctions", () => {
    it("should extract function declarations", () => {
      const code = "function test(a) { return a; }";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test");
    });

    it("should extract method definitions", () => {
      const code = "class A { method() {} }";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("method");
    });

    it("should extract arrow functions assigned to variables", () => {
      const code = "const fn = () => {};";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("fn");
    });

    it("should handle empty or invalid code", () => {
      expect(strategy.extractFunctions("")).toEqual([]);
      expect(strategy.extractFunctions("invalid code")).toEqual([]);
    });
  });

  describe("countDecisionPoints", () => {
    it("should count if statements and logical operators", () => {
      const code = "if (a && b || c) { d = e ? f : g; }";
      // 1 (if) + 1 (&&) + 1 (||) + 1 (?) = 4
      const count = strategy.countDecisionPoints(code, 1, 10);
      expect(count).toBe(4);
    });

    it("should respect line boundaries", () => {
      const code = "if (true) {}\n// line 2\nif (false) {}";
      const count = strategy.countDecisionPoints(code, 1, 1);
      expect(count).toBe(1);
    });
  });

  describe("extractIdentifiers", () => {
    it("should extract classes, interfaces, and variables", () => {
      const code = "class MyClass {}\ninterface MyInterface {}\nconst myVar = 1;";
      const idents = strategy.extractIdentifiers(code);
      expect(idents.map(i => i.name)).toContain("MyClass");
      expect(idents.map(i => i.name)).toContain("MyInterface");
      expect(idents.map(i => i.name)).toContain("myVar");
    });
  });

  describe("stripCommentsAndImports", () => {
    it("should remove imports and comments and collapse whitespace", () => {
      const code = `
        import { x } from 'y';
        /** comment */
        function test() {
          // single line
          return 1;
        }
      `;
      const result = strategy.stripCommentsAndImports(code);
      expect(result).toBe("function test() { return 1; }");
    });

    it("should clean up SVG paths in strings", () => {
      const code = "const svg = '<svg><path d=\"...\"/></svg>';";
      const result = strategy.stripCommentsAndImports(code);
      expect(result).toBe("const svg = '<svg></svg>';");
    });
  });
});
