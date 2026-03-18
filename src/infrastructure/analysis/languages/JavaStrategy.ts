// Copyright 2026 Google LLC

import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * JavaStrategy — regex-tuned for Java syntax (.java).
 */
export class JavaStrategy implements ILanguageStrategy {
  readonly extensions: string[] = [".java"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const lines = content.split("\n");
      const functions: FunctionBoundary[] = [];
      // public/private/protected [static] [final] <T> ReturnType name(args) {
      const methodRe =
        /(?:(?:public|private|protected|static|final|synchronized|abstract|default|native)\s+)*[\w<>[\].]+\s+([\w$]+)\s*\([^)]*\)\s*(?:throws\s+[\w$.,\s]+)?\s*\{/;

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
      const decisionPointRe =
        /\b(?:if|for|while|do|switch|case|catch|throw)\b|&&|\|\||\?|:/g;
      let count = 0;
      for (const line of lines) {
        // Strip string literals and comments
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
      const declarations: IdentifierDeclaration[] = [];
      const lines = content.split("\n");
      const classRe =
        /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+([\w$]+)\b/;
      const interfaceRe =
        /^\s*(?:(?:public|private|protected|static|final)\s+)*interface\s+([\w$]+)\b/;
      // Simplified method regex for identifier extraction
      const methodRe =
        /(?:(?:public|private|protected|static|final|synchronized|abstract|default|native)\s+)*[\w<>[\].]+\s+([\w$]+)\s*\([^)]*\)/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        if ((match = classRe.exec(line))) {
          declarations.push({ name: match[1], line: i + 1, kind: "class" });
        } else if ((match = interfaceRe.exec(line))) {
          declarations.push({ name: match[1], line: i + 1, kind: "interface" });
        } else if ((match = methodRe.exec(line))) {
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
      const lines = content.split("\n");
      // Double-quoted strings only for Java
      const regex = /"(?:\\.|[^"\\])*"/g;
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((match = regex.exec(lines[i])) !== null) {
          literals.push({ value: match[0].slice(1, -1), line: i + 1 });
        }
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
      // 3. Remove Java imports and package declaration
      optimized = optimized.replace(
        /^\s*import\s+(?:static\s+)?[\w.*]+\s*;/gm,
        "",
      );
      optimized = optimized.replace(/^\s*package\s+[\w.]+\s*;/gm, "");
      // 4. Collapse whitespace
      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      return content;
    }
  }
}
