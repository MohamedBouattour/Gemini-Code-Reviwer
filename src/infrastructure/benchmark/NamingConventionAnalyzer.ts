// Copyright 2026 Google LLC

/**
 * NamingConventionAnalyzer — checks identifier naming conventions.
 *
 * SRP: ONLY responsibility is naming convention analysis.
 *
 * ## Rules enforced (TypeScript / JavaScript / Java conventions)
 *
 *   | Construct        | Convention           | Example           |
 *   |------------------|----------------------|-------------------|
 *   | class            | PascalCase           | UserService       |
 *   | interface        | I + PascalCase       | IUserService      |
 *   | type alias       | PascalCase           | UserPayload       |
 *   | enum             | PascalCase           | HttpStatus        |
 *   | function/method  | camelCase            | getUserById       |
 *   | const (module)   | UPPER_SNAKE_CASE     | MAX_RETRIES       |
 *   | variable (let)   | camelCase            | localCount        |
 *
 * ## What is NOT checked
 *   - Parameter names (too noisy, depend on external contracts)
 *   - Destructured variables
 *   - Single-letter variables (i, j, k, x, y, _)
 *   - Names starting with _ (conventionally private / ignored)
 *   - Names inside comments or strings
 *
 * ## File naming
 *   - .ts/.js files should be kebab-case or PascalCase
 *   - Violations are flagged at line 1
 */

import * as path from "node:path";
import { LanguageStrategyManager } from "../analysis/languages/LanguageStrategyManager.js";
import type { CodeSegment } from "../../core/entities/CodeSegment.js";
import type {
  NamingConventionReport,
  NamingViolation,
  NamingViolationKind,
} from "../../core/entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Convention predicates
// ─────────────────────────────────────────────────────────────────────────────

const isPascalCase = (s: string): boolean => /^[A-Z][a-zA-Z0-9]*$/.test(s);
const isCamelCase = (s: string): boolean => /^[a-z][a-zA-Z0-9]*$/.test(s);
const isUpperSnakeCase = (s: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(s);
const isIPrefixPascal = (s: string): boolean => /^I[A-Z][a-zA-Z0-9]*$/.test(s);
const isKebabOrPascalFile = (s: string): boolean =>
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(s) || /^[A-Z][a-zA-Z0-9]*$/.test(s);

/** Names that are globally excluded from naming checks. */
const SKIP_NAMES = new Set([
  "constructor",
  "ngOnInit",
  "ngOnDestroy",
  "ngOnChanges",
  "ngAfterViewInit",
  "ngAfterContentInit",
  "render",
  "componentDidMount",
  "componentDidUpdate",
  "componentWillUnmount",
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  "main",
  "setUp",
  "tearDown",
]);

/** Skip names that are too short to be meaningful. */
const isTooShort = (s: string): boolean => s.length <= 1;
/** Skip names that start with _ (deliberately ignored / private). */
const isPrivateConvention = (s: string): boolean => s.startsWith("_");

// ─────────────────────────────────────────────────────────────────────────────
// NamingConventionAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

export class NamingConventionAnalyzer {
  analyze(files: CodeSegment[]): NamingConventionReport {
    const allViolations: NamingViolation[] = [];
    let totalChecked = 0;

    for (const file of files) {
      // Check file name itself (TS/JS only)
      const ext = path.extname(file.filePath);
      if (ext === ".ts" || ext === ".js" || ext === ".tsx" || ext === ".jsx") {
        const baseName = path.basename(file.filePath, ext);
        totalChecked++;
        if (!isKebabOrPascalFile(baseName)) {
          allViolations.push({
            filePath: file.filePath,
            line: 1,
            kind: "file-not-kebab-or-pascal",
            actual: baseName,
            expected: this.toKebabCase(baseName),
          });
        }
      }

      const strategy = LanguageStrategyManager.getStrategy(file.filePath);
      const identifiers = strategy.extractIdentifiers(file.originalContent);

      for (const id of identifiers) {
        if (
          !id.name ||
          isTooShort(id.name) ||
          isPrivateConvention(id.name) ||
          SKIP_NAMES.has(id.name)
        )
          continue;

        totalChecked++;

        let violationKind: NamingViolationKind | undefined;
        let expected: string | undefined;

        switch (id.kind) {
          case "class":
            if (!isPascalCase(id.name)) {
              violationKind = "class-not-pascal-case";
              expected = this.toPascalCase(id.name);
            }
            break;
          case "interface":
            if (!isIPrefixPascal(id.name)) {
              violationKind = "interface-missing-i-prefix";
              expected = "I" + this.toPascalCase(id.name.replace(/^I/, ""));
            }
            break;
          case "type":
          case "enum":
            if (!isPascalCase(id.name)) {
              violationKind =
                id.kind === "type"
                  ? "type-not-pascal-case"
                  : "enum-not-pascal-case";
              expected = this.toPascalCase(id.name);
            }
            break;
          case "function":
          case "variable":
            if (!isCamelCase(id.name)) {
              violationKind =
                id.kind === "function"
                  ? "function-not-camel-case"
                  : "variable-not-camel-case";
              expected = this.toCamelCase(id.name);
            }
            break;
          case "constant": {
            const looksLikeConstant =
              /^[A-Z_][A-Z0-9_]*$/.test(id.name) ||
              id.name === id.name.toUpperCase();
            if (looksLikeConstant && !isUpperSnakeCase(id.name)) {
              violationKind = "constant-not-upper-snake";
              expected = this.toUpperSnakeCase(id.name);
            }
            break;
          }
        }

        if (violationKind && expected) {
          allViolations.push({
            filePath: file.filePath,
            line: id.line,
            kind: violationKind,
            actual: id.name,
            expected: expected,
          });
        }
      }
    }

    const totalViolations = allViolations.length;
    const score =
      totalChecked === 0
        ? 100
        : Math.round(((totalChecked - totalViolations) / totalChecked) * 100);

    return {
      score,
      totalChecked,
      totalViolations,
      // Cap at 20 most impactful, sorted by file+line
      violations: allViolations
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
        .slice(0, 20),
    };
  }

  // ── Name transformers ─────────────────────────────────────────────────────────

  private toPascalCase(name: string): string {
    return name
      .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
      .replace(/^(.)/, (c: string) => c.toUpperCase());
  }

  private toCamelCase(name: string): string {
    const pascal = this.toPascalCase(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  }

  private toUpperSnakeCase(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toUpperCase();
  }

  private toKebabCase(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/_/g, "-")
      .toLowerCase();
  }
}
