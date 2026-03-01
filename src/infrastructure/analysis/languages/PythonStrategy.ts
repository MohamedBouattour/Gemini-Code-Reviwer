// Copyright 2026 Google LLC

import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * PythonStrategy — regex-tuned for Python syntax (.py).
 */
export class PythonStrategy implements ILanguageStrategy {
  readonly extensions: string[] = [".py"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const lines = content.split("\n");
      const functions: FunctionBoundary[] = [];
      const methodRe = /^\s*(?:async\s+)?def\s+([\w$]+)\s*\(/;

      for (let i = 0; i < lines.length; i++) {
        const match = methodRe.exec(lines[i]);
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
      const decisionPointRe = /\b(?:if|elif|for|while|except|with|and|or)\b/g;
      let count = 0;
      for (const line of lines) {
        // Strip single-line comments and basic strings
        const stripped = line
          .replace(/#.*$/, "")
          .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
        count += (stripped.match(decisionPointRe) ?? []).length;
      }
      return count;
    } catch {
      return 0;
    }
  }

  extractIdentifiers(content: string): IdentifierDeclaration[] {
    try {
      const declarations: IdentifierDeclaration[] = [];
      const lines = content.split("\n");
      const classRe = /^\s*class\s+([\w$]+)(?:\(.*\))?:/;
      const funcRe = /^\s*(?:async\s+)?def\s+([\w$]+)\s*\(/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        if ((match = classRe.exec(line))) {
          declarations.push({ name: match[1], line: i + 1, kind: "class" });
        } else if ((match = funcRe.exec(line))) {
          declarations.push({ name: match[1], line: i + 1, kind: "function" });
        }
      }
      return declarations;
    } catch {
      return [];
    }
  }

  extractStringLiterals(content: string): StringLiteral[] {
    try {
      const literals: StringLiteral[] = [];
      // Combine triple quotes and single/double quotes
      const regex =
        /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
      const matches = [...content.matchAll(regex)];

      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        const line =
          (content.slice(0, matchIndex).match(/\n/g) ?? []).length + 1;
        let val = match[0];
        if (val.startsWith('"""') || val.startsWith("'''")) {
          val = val.slice(3, -3);
        } else {
          val = val.slice(1, -1);
        }
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
      // 1. Remove triple-quoted strings (often used for docstrings/comments)
      optimized = optimized.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "");
      // 2. Remove single-line comments
      optimized = optimized.replace(/#.*$/gm, "");
      // 3. Remove Python imports
      optimized = optimized.replace(
        /^\s*(?:import\s+[\w.,\s]+|from\s+[\w.]+\s+import\s+[\w.,\s*()]+)/gm,
        "",
      );
      // 4. Collapse whitespace
      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      return content;
    }
  }
}
