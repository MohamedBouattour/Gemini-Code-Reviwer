import { describe, it, expect } from "vitest";
import { GenericStrategy } from "../src/infrastructure/analysis/languages/GenericStrategy.js";

describe("GenericStrategy", () => {
  const strategy = new GenericStrategy();

  describe("extractFunctions", () => {
    it("should extract function declarations using regex", () => {
      const code = "function test() {}";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test");
    });

    it("should extract class methods using regex", () => {
      const code = "class A { public method() {} }";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("method");
    });
  });

  describe("countDecisionPoints", () => {
    it("should count decision points using regex", () => {
      const code = "if (a && b) { while(c) {} }";
      const count = strategy.countDecisionPoints(code, 1, 1);
      expect(count).toBe(3); // if, &&, while
    });
  });

  describe("extractIdentifiers", () => {
    it("should extract basics using regex", () => {
      const code = "class MyClass {}\ninterface MyInterface {}";
      const idents = strategy.extractIdentifiers(code);
      expect(idents.map(i => i.name)).toContain("MyClass");
      expect(idents.map(i => i.name)).toContain("MyInterface");
    });
  });

  describe("stripCommentsAndImports", () => {
    it("should strip comments and imports", () => {
      const code = "import 'x'; // comment\nfunction a() {}";
      const result = strategy.stripCommentsAndImports(code);
      expect(result).toBe("function a() {}");
    });
  });
});
