// Copyright 2026 Google LLC

import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * GenericStrategy — fallback for unsupported languages.
 * Uses the existing conservative regex-based approach.
 */
export class GenericStrategy implements ILanguageStrategy {
  readonly extensions: string[] = ["*"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const lines = content.split("\n");
      const functions: FunctionBoundary[] = [];
      const functionStartRe =
        /(?:^|\s)(?:async\s+)?(?:function\s+([\w$]+)|(?:public|private|protected|static|override|async|\s)*([\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]*)?\{|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{)/;

      for (let i = 0; i < lines.length; i++) {
        const match = functionStartRe.exec(lines[i]);
        if (match) {
          functions.push({
            name: match[1] ?? match[2] ?? match[3] ?? "(anonymous)",
            startLine: i + 1,
          });
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
        /\b(?:if|else\s+if|for|while|do|switch|case|catch)\b|\?\?|\?(?!:)|&&|\|\|/g;
      let count = 0;
      for (const line of lines) {
        // Simple stripping to avoid false positives in strings/comments
        const stripped = line
          .replace(/\/\/.*$/, "")
          .replace(/["'`].*?["'`]/g, "");
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
      const regexes: Array<{
        re: RegExp;
        kind: IdentifierDeclaration["kind"];
      }> = [
        {
          re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
          kind: "class",
        },
        {
          re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
          kind: "interface",
        },
        {
          re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<|=)/,
          kind: "type",
        },
        {
          re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
          kind: "enum",
        },
        {
          re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
          kind: "function",
        },
        {
          re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/,
          kind: "constant",
        },
        {
          re: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*[=:]/,
          kind: "variable",
        },
      ];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, kind } of regexes) {
          const match = re.exec(line);
          if (match) {
            declarations.push({ name: match[1], line: i + 1, kind });
          }
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
      const regex = /(["'`])((?:(?=(\\?))\3.)*?)\1/g;
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((match = regex.exec(lines[i])) !== null) {
          literals.push({ value: match[2], line: i + 1 });
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
      // 1. Strip inner paths from SVG elements
      optimized = optimized.replace(
        /(<svg\b[^>]*>)(.*?)(<\/svg>)/gs,
        (_match, p1, _p2, p3) => p1 + p3,
      );
      // 2. Remove multi-line comments /* ... */
      optimized = optimized.replace(/\/\*[\s\S]*?\*\//g, "");
      // 3. Remove single-line comments // ...
      optimized = optimized.replace(/(?<!https?:)\/\/.*$/gm, "");
      // 4. Remove imports
      optimized = optimized.replace(
        /^\s*import\s+[^;]*?from\s+['"].*?['"]\s*;/gm,
        "",
      );
      optimized = optimized.replace(/^\s*import\s+['"].*?['"]\s*;/gm, "");
      optimized = optimized.replace(
        /^\s*import\s+(?:static\s+)?[\w.*]+\s*;/gm,
        "",
      );

      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      return content;
    }
  }
}
