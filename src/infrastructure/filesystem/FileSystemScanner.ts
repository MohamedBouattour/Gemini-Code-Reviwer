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
import { LanguageStrategyManager } from "../analysis/languages/LanguageStrategyManager.js";
import type { IFileScanner } from "../../core/interfaces/IFileScanner.js";
import type { ScannedProject } from "../../core/interfaces/IFileScanner.js";
import type { CodeSegment } from "../../core/entities/CodeSegment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Content optimiser (minifier)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minify source content to reduce token cost for the AI prompt.
 * Delegates to language-specific strategies.
 */
export function optimizeContent(filePath: string, content: string): string {
  try {
    const strategy = LanguageStrategyManager.getStrategy(filePath);
    return strategy.stripCommentsAndImports(content);
  } catch {
    // Fallback if strategy fails
    return content.replace(/\s+/g, " ").trim();
  }
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
        const optimizedContent = optimizeContent(filePath, rawContent);
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
