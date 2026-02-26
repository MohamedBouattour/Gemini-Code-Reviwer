// Copyright 2026 Google LLC

/**
 * FileSystemScanner — implements IFileScanner using fast-glob and node:fs.
 *
 * Migration target: src/scanner.ts → src/infrastructure/filesystem/FileSystemScanner.ts
 *
 * ## Responsibilities (SRP)
 *   - Discover all code files matching configured glob patterns.
 *   - Read and minify file content (strips comments, imports, whitespace)
 *     to maximise token efficiency in AI review batches.
 *   - Respect .gitignore exclusions.
 *
 * ## Clean Architecture compliance
 *   - Implements IFileScanner (Core interface).
 *   - Zero imports from the Application or Presentation layers.
 *   - The Application layer (RunCodeReview) never imports this class directly;
 *     it receives an IFileScanner instance via Constructor Injection.
 */

import fg from "fast-glob";
import fs from "fs/promises";
import * as path from "path";

import type { IFileScanner } from "../../core/interfaces/IFileScanner.js";
import type { ScannedProject } from "../../core/interfaces/IFileScanner.js";
import type { CodeSegment } from "../../core/entities/CodeSegment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Content optimiser (minifier)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minify source content to reduce token cost for the AI prompt.
 *
 * Operations (in order):
 *  1. Strip inner SVG path data (large, irrelevant to logic).
 *  2. Remove multi-line comments  /* ... *​/
 *  3. Remove single-line comments // ...  (preserves URLs like https://)
 *  4. Remove JS/TS import statements.
 *  5. Remove Java import statements.
 *  6. Collapse all whitespace to a single space.
 */
export function optimizeContent(content: string): string {
  let optimized = content.replace(/\r\n/g, "\n");

  // 1. Strip inner paths from SVG elements
  optimized = optimized.replace(
    /(<svg\b[^>]*>)(.*?)(<\/svg>)/gs,
    (_match, p1, _p2, p3) => p1 + p3,
  );

  // 2. Remove multi-line comments /* ... */
  optimized = optimized.replace(/\/\*[\s\S]*?\*\//g, "");

  // 3. Remove single-line comments // ... (preserve https://)
  optimized = optimized.replace(/(?<!https?:)\/\/.*$/gm, "");

  // 4a. JS/TS: `import ... from '...'`
  optimized = optimized.replace(
    /^\s*import\s+[^;]*?from\s+['"].*?['"]\s*;/gm,
    "",
  );
  // 4b. JS/TS: bare `import '...'`
  optimized = optimized.replace(/^\s*import\s+['"].*?['"]\s*;/gm, "");
  // 4c. Java: `import java.util.List;` / `import static ...;`
  optimized = optimized.replace(/^\s*import\s+(?:static\s+)?[\w.*]+\s*;/gm, "");

  // 5. Collapse whitespace
  optimized = optimized.replace(/\s+/g, " ").trim();

  return optimized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob patterns
// ─────────────────────────────────────────────────────────────────────────────

const CODE_GLOB_PATTERN = "src/**/*.{java,ts,js,tsx,jsx,html,css,scss}";

const BASE_IGNORE_LIST = [
  "**/*.spec.*",
  "**/*.test.*",
  "**/__tests__/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".git/**",
];

// ─────────────────────────────────────────────────────────────────────────────
// FileSystemScanner — IFileScanner implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FileSystemScanner
 *
 * Thin wrapper around fast-glob + node:fs that produces the ScannedProject
 * required by RunCodeReview and BootstrapProject.
 *
 * Note: This scanner only populates `codeFiles`. For a full ScannedProject
 * (iacFiles, configFiles, ciFiles, sampleSources, etc.), use ProjectScanner
 * from project-scanner.ts (wired via DependencyContainer).
 *
 * Future: When ProjectScanner is fully migrated it will be replaced by this
 * class; until then, DependencyContainer wraps ProjectScanner as IFileScanner.
 */
export class FileSystemScanner implements IFileScanner {
  async scan(baseDir: string): Promise<ScannedProject> {
    const ignoreList = [
      ...BASE_IGNORE_LIST,
      ...(await this.readGitIgnore(baseDir)),
    ];

    const filePaths = await fg([CODE_GLOB_PATTERN], {
      cwd: baseDir,
      ignore: ignoreList,
      absolute: true,
    });

    const codeFiles: CodeSegment[] = [];

    for (const filePath of filePaths) {
      try {
        const rawContent = await fs.readFile(filePath, "utf-8");
        const optimizedContent = optimizeContent(rawContent);
        const relativePath = path.relative(baseDir, filePath);
        codeFiles.push({
          filePath: relativePath,
          originalContent: rawContent,
          content: optimizedContent,
        });
      } catch (e) {
        console.warn(`FileSystemScanner: could not read ${filePath}:`, e);
      }
    }

    // Return a minimal ScannedProject — DependencyContainer uses ProjectScanner
    // for the full context (IaC, configs, CI, samples).
    return {
      codeFiles,
      iacFiles: {},
      dependencyManifests: {},
      configFiles: {},
      ciFiles: {},
      sampleSources: [],
      sampleTests: [],
      packageJson: undefined,
      directoryTree: "",
      isPublicFacing: false,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async readGitIgnore(baseDir: string): Promise<string[]> {
    try {
      const gitignoreContent = await fs.readFile(
        path.join(baseDir, ".gitignore"),
        "utf-8",
      );
      return gitignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          let pattern = line.startsWith("/") ? line.substring(1) : "**/" + line;
          if (pattern.endsWith("/")) pattern += "**";
          return pattern;
        });
    } catch {
      return [];
    }
  }
}
