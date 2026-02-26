// Copyright 2026 Google LLC

/**
 * IFileScanner — port for filesystem scan operations.
 *
 * Lives in the Core layer. Zero filesystem imports.
 * Implementation (FastGlobScanner) lives in infrastructure/filesystem/.
 */

import type { CodeSegment } from "../entities/CodeSegment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scan result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete project context produced by a filesystem scan.
 * This is what both use cases (RunCodeReview, BootstrapProject) consume.
 */
export interface ScannedProject {
  /** Source files ready for AI analysis. */
  codeFiles: CodeSegment[];
  /** IaC files (Dockerfile, .tf, k8s yaml) keyed by relative path. */
  iacFiles: Record<string, string>;
  /** Dependency manifests (package.json, pom.xml) keyed by relative path. */
  dependencyManifests: Record<string, string>;
  /** Config files (tsconfig.json, .eslintrc) keyed by relative path. */
  configFiles: Record<string, string>;
  /** CI pipeline files (.github/workflows/*.yml) keyed by relative path. */
  ciFiles: Record<string, string>;
  /** 5–10 representative business-logic source files (for skill generation). */
  sampleSources: Array<{ relPath: string; content: string }>;
  /** 5–10 representative test files (for skill generation). */
  sampleTests: Array<{ relPath: string; content: string }>;
  /** Serialised package.json (for skill generation context). */
  packageJson?: string;
  /** ASCII directory tree, depth 3 (for skill generation context). */
  directoryTree: string;
  /** True if IaC patterns suggest internet-facing infrastructure. */
  isPublicFacing: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// IFileScanner — the contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IFileScanner
 *
 * Abstracts filesystem access behind a clean port.
 * The application layer calls scan() — it never touches `fs`, `fast-glob`, etc.
 */
export interface IFileScanner {
  /**
   * Scan the given directory and return a structured project context.
   *
   * @param baseDir  Absolute path to the project root.
   */
  scan(baseDir: string): Promise<ScannedProject>;
}
