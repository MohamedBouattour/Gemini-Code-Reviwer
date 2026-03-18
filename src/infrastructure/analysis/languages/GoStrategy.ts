// Copyright 2026 Google LLC

import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * GoStrategy — regex-tuned for Go syntax (.go).
 */
export class GoStrategy implements ILanguageStrategy {
  readonly extensions: string[] = [".go"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const lines = content.split("\n");
      const functions: FunctionBoundary[] = [];
      // func (r *Receiver) Method() { OR func Function() {
      const funcRe = /^\s*func\s+(?:\([^)]*\)\s+)?([\w$]+)\s*\(/;

      for (let i = 0; i < lines.length; i++) {
        const match = funcRe.exec(lines[i]);
        if (match) {
          functions.push({ name: match[1], startLine: i + 1 });
        }
      }
      return functions;
    } catch {
      return [];
    }
  }

  countDecisionPoints(
    content: string,
    startLine: number,
    endLine: number,
  ): number {
    try {
      const lines = content.split("\n").slice(startLine - 1, endLine);
      const decisionPointRe = /\b(?:if|for|case|select|go|defer)\b|&&|\|\|/g;
      let count = 0;
      for (const line of lines) {
        // Strip comments and basic strings
        const stripped = line
          .replace(/\/\/.*$/, "")
          .replace(/`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"/g, '""');
        count += (stripped.match(decisionPointRe) ?? []).length;
      }
      return count;
    } catch {
      return 0;
    }
  }

  extractIdentifiers(content: string): IdentifierDeclaration[] {
    try {
      const idents: IdentifierDeclaration[] = [];
      const lines = content.split("\n");
      // Types: type MyStruct struct, type MyInterface interface
      const typeRe = /^\s*type\s+([\w$]+)\s+(?:struct|interface|func|[\w$]+)\b/;
      // Functions / Methods
      const funcRe = /^\s*func\s+(?:\([^)]*\)\s+)?([\w$]+)\s*\(/;
      // Global Vars / Consts
      const varRe = /^\s*(?:var|const)\s+([\w$]+)\b/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        if ((match = typeRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "type" });
        } else if ((match = funcRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "function" });
        } else if ((match = varRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "variable" });
        }
      }
      return idents;
    } catch {
      return [];
    }
  }

  extractStringLiterals(content: string): StringLiteral[] {
    try {
      const literals: StringLiteral[] = [];
      // Backticks (raw strings) and double quotes
      const regex = /`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"/g;
      const matches = [...content.matchAll(regex)];

      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        const line =
          (content.slice(0, matchIndex).match(/\n/g) ?? []).length + 1;
        const val = match[0].slice(1, -1);
        literals.push({ value: val, line });
      }
      return literals;
    } catch {
      return [];
    }
  }

  stripCommentsAndImports(content: string): string {
    try {
      let optimized = content.replace(/\r\n/g, "\n");
      // 1. Remove multi-line comments /* ... */
      optimized = optimized.replace(/\/\*[\s\S]*?\*\//g, "");
      // 2. Remove single-line comments // ...
      optimized = optimized.replace(/(?<!https?:)\/\/.*$/gm, "");
      // 3. Remove Go imports
      optimized = optimized.replace(/^\s*import\s+\([^)]*\)/gm, "");
      optimized = optimized.replace(/^\s*import\s+["'][^"']+["']/gm, "");
      // 4. Remove package declaration
      optimized = optimized.replace(/^\s*package\s+[\w$]+/gm, "");
      // 5. Collapse whitespace
      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      return content;
    }
  }
}
