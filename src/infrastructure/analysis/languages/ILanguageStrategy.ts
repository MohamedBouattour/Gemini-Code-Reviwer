// Copyright 2026 Google LLC

export interface FunctionBoundary {
  name: string;
  startLine: number;
}

export type IdentifierKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "constant"
  | "variable";

export interface IdentifierDeclaration {
  name: string;
  line: number;
  kind: IdentifierKind;
}

export interface StringLiteral {
  value: string;
  line: number;
}

/**
 * ILanguageStrategy — interface for language-specific code analysis.
 *
 * All methods must handle errors gracefully and return empty/original data on failure.
 */
export interface ILanguageStrategy {
  /** File extensions this strategy handles (e.g., ['.ts', '.tsx']). */
  readonly extensions: string[];

  /** Extract all function/method names and their starting line numbers. */
  extractFunctions(content: string): FunctionBoundary[];

  /** Count decision points (if, for, while, etc.) within a line range. */
  countDecisionPoints(
    content: string,
    startLine: number,
    endLine: number,
  ): number;

  /** Extract all significant identifiers (classes, functions, etc.) for naming analysis. */
  extractIdentifiers(content: string): IdentifierDeclaration[];

  /** Extract all string literals for security auditing. */
  extractStringLiterals(content: string): StringLiteral[];

  /** Remove comments and import/include statements to optimize content for AI. */
  stripCommentsAndImports(content: string): string;
}
