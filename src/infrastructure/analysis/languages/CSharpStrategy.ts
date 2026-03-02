// Copyright 2026 Google LLC

import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * CSharpStrategy — regex-tuned for C# syntax (.cs).
 */
export class CSharpStrategy implements ILanguageStrategy {
  readonly extensions: string[] = [".cs"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const lines = content.split("\n");
      const functions: FunctionBoundary[] = [];
      // [Modifiers] ReturnType MethodName(args)
      const methodRe =
        /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|extern)\s+)+[\w<>\[\].?]+\s+([\w$]+)\s*\(/;

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
      // Includes LINQ operators as decision points
      const decisionPointRe =
        /\b(?:if|for|foreach|while|do|switch|case|catch|goto|throw)\b|&&|\|\||\?|:|\.(?:Where|Any|All|Select|FirstOrDefault|SingleOrDefault)\(/g;
      let count = 0;
      for (const line of lines) {
        // Strip comments and basic strings
        const stripped = line
          .replace(/\/\/.*$/, "")
          .replace(/"(?:\\.|[^"\\])*"/g, '""');
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
      const classRe =
        /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*class\s+([\w$]+)\b/;
      const interfaceRe =
        /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([\w$]+)\b/;
      const methodRe =
        /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed)\s+)+[\w<>\[\].?]+\s+([\w$]+)\s*\(/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        if ((match = classRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "class" });
        } else if ((match = interfaceRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "interface" });
        } else if ((match = methodRe.exec(line))) {
          idents.push({ name: match[1], line: i + 1, kind: "function" });
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
      // C# strings: normal "..." and verbatim @"..."
      const regex = /@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"/g;
      const matches = [...content.matchAll(regex)];

      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        const line =
          (content.slice(0, matchIndex).match(/\n/g) ?? []).length + 1;
        let val = match[0];
        if (val.startsWith("@")) {
          val = val.slice(2, -1).replace(/""/g, '"');
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
      // 1. Remove multi-line comments /* ... */
      optimized = optimized.replace(/\/\*[\s\S]*?\*\//g, "");
      // 2. Remove single-line comments // ...
      optimized = optimized.replace(/(?<!https?:)\/\/.*$/gm, "");
      // 3. Remove usings and namespaces
      optimized = optimized.replace(/^\s*using\s+[\w.]+;/gm, "");
      optimized = optimized.replace(/^\s*namespace\s+[\w.]+;?/gm, "");
      // 4. Collapse whitespace
      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      return content;
    }
  }
}
