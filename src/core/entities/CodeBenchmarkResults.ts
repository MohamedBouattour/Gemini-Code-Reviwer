// Copyright 2026 Google LLC

/**
 * CodeBenchmarkResults — output entity for the local benchmark auditor.
 *
 * Lives in the Core layer. Produced by CodeBenchmarkAuditor,
 * stored in ProjectReport.localBenchmarks, rendered by IReportBuilder.
 *
 * All metrics are computed locally — zero AI tokens consumed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Complexity
// ─────────────────────────────────────────────────────────────────────────────

/** Per-function cyclomatic complexity measurement. */
export interface FunctionComplexity {
  /** Relative file path. */
  filePath: string;
  /** Function / method name as extracted from source. */
  functionName: string;
  /** 1-indexed line where the function starts. */
  startLine: number;
  /** Cyclomatic complexity score (1 = linear, > 10 = complex). */
  complexity: number;
}

export interface ComplexityReport {
  /** Average cyclomatic complexity across all measured functions. */
  averageComplexity: number;
  /** Maximum cyclomatic complexity found in any single function. */
  maxComplexity: number;
  /** Functions with complexity > HIGH_COMPLEXITY_THRESHOLD (default 10). */
  hotspots: FunctionComplexity[];
  /** Total number of functions analysed. */
  totalFunctions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplication
// ─────────────────────────────────────────────────────────────────────────────

/** A duplicated code block found across one or more files. */
export interface DuplicateBlock {
  /** Hash fingerprint of the normalised block. */
  hash: string;
  /** Number of lines in the block. */
  lines: number;
  /** All locations where this block appears. */
  locations: Array<{ filePath: string; startLine: number }>;
}

export interface DuplicationReport {
  /** Percentage of total lines that are duplicated (0–100). */
  duplicationPercentage: number;
  /** Total lines of code analysed. */
  totalLines: number;
  /** Total lines identified as duplicated. */
  duplicatedLines: number;
  /** Top duplicate blocks (sorted by lines × occurrences, descending). */
  topBlocks: DuplicateBlock[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming conventions
// ─────────────────────────────────────────────────────────────────────────────

export type NamingViolationKind =
  | "class-not-pascal-case"
  | "function-not-camel-case"
  | "constant-not-upper-snake"
  | "variable-not-camel-case"
  | "interface-missing-i-prefix"
  | "type-not-pascal-case"
  | "enum-not-pascal-case"
  | "file-not-kebab-or-pascal";

export interface NamingViolation {
  filePath: string;
  line: number;
  kind: NamingViolationKind;
  /** The actual name found in source. */
  actual: string;
  /** Suggested corrected name. */
  expected: string;
}

export interface NamingConventionReport {
  /** 0–100: percentage of identifiers that comply with conventions. */
  score: number;
  /** Total identifiers checked. */
  totalChecked: number;
  /** Total violations found. */
  totalViolations: number;
  /** Up to 20 most impactful violations (sorted by file + line). */
  violations: NamingViolation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────────────

/** Full output of the CodeBenchmarkAuditor. */
export interface CodeBenchmarkResults {
  complexity: ComplexityReport;
  duplication: DuplicationReport;
  naming: NamingConventionReport;
  /** ISO timestamp of when the benchmark was run. */
  timestamp: string;
}
