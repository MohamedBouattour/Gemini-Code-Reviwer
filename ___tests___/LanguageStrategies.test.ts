import { describe, it, expect } from "vitest";
import { CSharpStrategy } from "../src/infrastructure/analysis/languages/CSharpStrategy.js";
import { GoStrategy } from "../src/infrastructure/analysis/languages/GoStrategy.js";
import { PythonStrategy } from "../src/infrastructure/analysis/languages/PythonStrategy.js";
import { JavaStrategy } from "../src/infrastructure/analysis/languages/JavaStrategy.js";

describe("Language Strategies", () => {
  describe("CSharpStrategy", () => {
    const strategy = new CSharpStrategy();
    it("should extract methods", () => {
      const code = "public static void Main(string[] args) {}";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Main");
    });
    it("should strip comments and usings", () => {
      const code = "using System;\n// comment\nclass A {}";
      expect(strategy.stripCommentsAndImports(code)).toBe("class A {}");
    });
    it("should extract identifiers", () => {
      const code = "class MyClass\n{\n    public void MyMethod()\n    {\n    }\n}";
      const result = strategy.extractIdentifiers(code);
      expect(result).toContainEqual({ name: "MyClass", line: 1, kind: "class" });
      expect(result).toContainEqual({ name: "MyMethod", line: 3, kind: "function" });
    });
    it("should extract string literals", () => {
      const code = 'string s = "normal"; string v = @"verbatim";';
      const result = strategy.extractStringLiterals(code);
      expect(result[0].value).toBe("normal");
      expect(result[1].value).toBe("verbatim");
    });
    it("should count decision points", () => {
      const code = "if (a && b || c) { foreach (var x in list) { return x.Prop; } }";
      // if, &&, ||, foreach. The strategy counts '&&', '||' and keywords.
      expect(strategy.countDecisionPoints(code, 1, 1)).toBe(4);
    });
  });

  describe("GoStrategy", () => {
    const strategy = new GoStrategy();
    it("should extract functions", () => {
      const code = "func main() {}";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("main");
    });
    it("should count decision points including select/chan", () => {
      const code = "if a { select { case <-ch: } }";
      expect(strategy.countDecisionPoints(code, 1, 1)).toBe(3); // if, select, case
    });
    it("should extract identifiers", () => {
      const code = "type MyStruct struct {}\nfunc (m *MyStruct) MyMethod() {}";
      const result = strategy.extractIdentifiers(code);
      expect(result).toContainEqual({ name: "MyStruct", line: 1, kind: "type" });
      expect(result).toContainEqual({ name: "MyMethod", line: 2, kind: "function" });
    });
    it("should extract string literals", () => {
      const code = 's := "normal"; r := `raw`';
      const result = strategy.extractStringLiterals(code);
      expect(result[0].value).toBe("normal");
      expect(result[1].value).toBe("raw");
    });
  });

  describe("PythonStrategy", () => {
    const strategy = new PythonStrategy();
    it("should extract functions and methods", () => {
      const code = "def test(): pass\nclass A:\n    def method(self): pass";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("test");
      expect(result[1].name).toBe("method");
    });
    it("should strip comments and imports", () => {
      const code = `
import os
from sys import path
# comment
"""docstring"""
def a():
    pass
      `;
      const result = strategy.stripCommentsAndImports(code);
      expect(result).toBe("def a(): pass");
    });
    it("should extract identifiers", () => {
      const code = "class MyClass:\n    def my_func(): pass";
      const result = strategy.extractIdentifiers(code);
      expect(result).toContainEqual({ name: "MyClass", line: 1, kind: "class" });
      expect(result).toContainEqual({ name: "my_func", line: 2, kind: "function" });
    });
    it("should extract string literals", () => {
      const code = 's = "basic"\nd = """triple"""';
      const result = strategy.extractStringLiterals(code);
      expect(result).toContainEqual({ value: "basic", line: 1 });
      expect(result).toContainEqual({ value: "triple", line: 2 });
    });
    it("should count decision points", () => {
      const code = "if a and b or c: for x in y: pass";
      expect(strategy.countDecisionPoints(code, 1, 1)).toBe(4); // if, and, or, for
    });
  });

  describe("JavaStrategy", () => {
    const strategy = new JavaStrategy();
    it("should extract methods", () => {
      const code = "public class T {\n    public void test() {}\n}";
      const result = strategy.extractFunctions(code);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test");
    });
    it("should strip comments and package/imports", () => {
      const code = "package a.b;\nimport x.y;\n/** doc */\nclass A {}";
      expect(strategy.stripCommentsAndImports(code)).toBe("class A {}");
    });
    it("should extract identifiers", () => {
      const code = "class MyClass {\n    void myMethod() {}\n}";
      const result = strategy.extractIdentifiers(code);
      expect(result).toContainEqual({ name: "MyClass", line: 1, kind: "class" });
      expect(result).toContainEqual({ name: "myMethod", line: 2, kind: "function" });
    });
    it("should count decision points", () => {
      const code = "if (a && b) { while(true) { try { ... } catch(E e) {} } }";
      expect(strategy.countDecisionPoints(code, 1, 1)).toBe(4); // if, &&, while, catch
    });
  });
});
