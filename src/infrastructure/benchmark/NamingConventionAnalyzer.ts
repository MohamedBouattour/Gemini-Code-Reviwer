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
import type { CodeSegment } from "../../core/entities/CodeSegment.js";
import type {
  NamingConventionReport,
  NamingViolation,
  NamingViolationKind,
} from "../../core/entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regex rules
// ─────────────────────────────────────────────────────────────────────────────

// class Foo / abstract class Foo
const CLASS_DECL_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/;
// interface IFoo / interface Foo
const INTERFACE_DECL_RE = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/;
// type Foo = ...
const TYPE_ALIAS_RE = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<|=)/;
// enum Foo / const enum Foo
const ENUM_DECL_RE = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/;
// function foo() / async function foo()
const FUNCTION_DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/;
// public/private/protected method foo() inside a class
const METHOD_DECL_RE =
  /^\s*(?:(?:public|private|protected|static|override|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\{/;
// const FOO = ... (module-level constants: all caps → UPPER_SNAKE)
const CONST_DECL_RE = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/;
// let foo = ...
const LET_DECL_RE = /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*[=:]/;

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

      const lines = file.originalContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        // Skip comment lines
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ) continue;

        // Each check: try match, validate, push violation if needed
        const checks: Array<{
          re: RegExp;
          kind: NamingViolationKind;
          predicate: (n: string) => boolean;
          suggest: (n: string) => string;
        }> = [
          {
            re: CLASS_DECL_RE,
            kind: "class-not-pascal-case",
            predicate: isPascalCase,
            suggest: this.toPascalCase.bind(this),
          },
          {
            re: INTERFACE_DECL_RE,
            kind: "interface-missing-i-prefix",
            predicate: isIPrefixPascal,
            suggest: (n) => "I" + this.toPascalCase(n.replace(/^I/, "")),
          },
          {
            re: TYPE_ALIAS_RE,
            kind: "type-not-pascal-case",
            predicate: isPascalCase,
            suggest: this.toPascalCase.bind(this),
          },
          {
            re: ENUM_DECL_RE,
            kind: "enum-not-pascal-case",
            predicate: isPascalCase,
            suggest: this.toPascalCase.bind(this),
          },
          {
            re: FUNCTION_DECL_RE,
            kind: "function-not-camel-case",
            predicate: isCamelCase,
            suggest: this.toCamelCase.bind(this),
          },
        ];

        for (const check of checks) {
          const match = check.re.exec(line);
          if (!match) continue;
          const name = match[1];
          if (!name || isTooShort(name) || isPrivateConvention(name) || SKIP_NAMES.has(name)) continue;
          totalChecked++;
          if (!check.predicate(name)) {
            allViolations.push({
              filePath: file.filePath,
              line: lineNum,
              kind: check.kind,
              actual: name,
              expected: check.suggest(name),
            });
          }
        }

        // const: UPPER_SNAKE for ALL_CAPS names only (skip camelCase consts)
        const constMatch = CONST_DECL_RE.exec(line);
        if (constMatch) {
          const name = constMatch[1];
          if (name && !isTooShort(name) && !isPrivateConvention(name) && !SKIP_NAMES.has(name)) {
            totalChecked++;
            // Only flag if name looks like it tries to be UPPER_SNAKE but isn't
            const looksLikeConstant = /^[A-Z_][A-Z0-9_]*$/.test(name) || name === name.toUpperCase();
            if (looksLikeConstant && !isUpperSnakeCase(name)) {
              allViolations.push({
                filePath: file.filePath,
                line: lineNum,
                kind: "constant-not-upper-snake",
                actual: name,
                expected: this.toUpperSnakeCase(name),
              });
            }
          }
        }

        // let: camelCase
        const letMatch = LET_DECL_RE.exec(line);
        if (letMatch) {
          const name = letMatch[1];
          if (name && !isTooShort(name) && !isPrivateConvention(name) && !SKIP_NAMES.has(name)) {
            totalChecked++;
            if (!isCamelCase(name)) {
              allViolations.push({
                filePath: file.filePath,
                line: lineNum,
                kind: "variable-not-camel-case",
                actual: name,
                expected: this.toCamelCase(name),
              });
            }
          }
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
