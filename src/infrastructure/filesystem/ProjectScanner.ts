// Copyright 2026 Google LLC

/**
 * ProjectScanner — the single source of truth for everything the CLI knows
 * about a repository.
 *
 * Single Responsibility: scan the project ONCE and return a rich `ProjectContext`
 * that every downstream consumer (code reviewer, skills generator, infra auditor,
 * security scanner) can use directly — no secondary file I/O needed.
 *
 * Previously, skills generation (discovery.ts) and the code reviewer each ran
 * their own separate scans.  Unifying them means skills are generated from the
 * full code corpus, not just one sampled file, producing far more accurate and
 * project-specific guidance.
 */

import * as path from "node:path";
import * as nodefs from "node:fs/promises";
import fg from "fast-glob";
import { optimizeContent } from "./FileSystemScanner.js";
import { detectPublicExposure } from "../security/exposureDetector.js";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export CodeSegment so callers only need one import
// ─────────────────────────────────────────────────────────────────────────────

export type { CodeSegment as CodeFile } from "../../core/entities/CodeSegment.js";
import type { CodeSegment as CodeFile } from "../../core/entities/CodeSegment.js";

// ─────────────────────────────────────────────────────────────────────────────
// ProjectContext — everything downstream consumers need
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectContext {
  /** Absolute path of the project root. */
  baseDir: string;

  // ── Code review ────────────────────────────────────────────────────────────
  /** Source files with both raw and optimised content, deduped, .gitignore aware. */
  codeFiles: CodeFile[];

  // ── Skills generation (richer than the old 1-sample approach) ─────────────
  /** Content of root package.json (capped at 8 KB). */
  packageJson: string | null;
  /** ASCII directory tree, depth ≤ 3, noise dirs excluded. */
  directoryTree: string;
  /** Config files: tsconfig, eslint, jest/vitest, pom, prettier… */
  configFiles: Record<string, string>;
  /** CI/CD pipeline files: GitHub Actions, GitLab CI, etc. */
  ciFiles: Record<string, string>;
  /**
   * Representative test files for skills generation.
   * Up to 3 files, capped at 6 KB each.
   */
  sampleTests: Array<{ relPath: string; content: string }>;
  /**
   * Representative source files for skills generation.
   * Up to 5 files (services/controllers first), capped at 6 KB each.
   */
  sampleSources: Array<{ relPath: string; content: string }>;

  // ── Infrastructure / SCA audit ────────────────────────────────────────────
  /** IaC files: Dockerfile, docker-compose, .tf, K8s YAML, etc. */
  iacFiles: Record<string, string>;
  /** Dependency manifests: package.json, pom.xml, requirements.txt, … */
  dependencyManifests: Record<string, string>;

  // ── Derived ───────────────────────────────────────────────────────────────
  /** True when IaC heuristics detect public internet exposure. */
  isPublicFacing: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TREE_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  "target",
  "vendor",
  ".angular",
  ".cache",
  "coverage",
  ".turbo",
]);

const CODE_PATTERNS = "src/**/*.{java,ts,js,tsx,jsx,html,css,scss,py,rb,go,cs}";

const CONFIG_CANDIDATES: Record<string, string[]> = {
  "tsconfig.json": ["tsconfig.json", "tsconfig.*.json"],
  ".eslintrc": [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
  ],
  "jest.config": [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.cjs",
    "jest.config.mjs",
  ],
  "vitest.config": ["vitest.config.ts", "vitest.config.js"],
  "pom.xml": ["pom.xml"],
  "build.gradle": ["build.gradle", "build.gradle.kts"],
  ".prettierrc": [
    ".prettierrc",
    ".prettierrc.js",
    ".prettierrc.json",
    ".prettierrc.yml",
  ],
};

const CI_PATTERNS = [
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".circleci/config.yml",
  "bitbucket-pipelines.yml",
  ".codemagic.yaml",
  ".codemagic.yml",
];

const IAC_PATTERNS = [
  "Dockerfile",
  "Dockerfile.*",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "docker-compose.yml",
  "docker-compose.yaml",
  "docker-compose.*.yml",
  "docker-compose.*.yaml",
  "**/docker-compose.yml",
  "**/docker-compose.yaml",
  "**/*.tf",
  "**/*.tfvars",
  "k8s/**/*.yml",
  "k8s/**/*.yaml",
  "kubernetes/**/*.yml",
  "kubernetes/**/*.yaml",
  "helm/**/*.yml",
  "helm/**/*.yaml",
  "infra/**/*.yml",
  "infra/**/*.yaml",
  "deploy/**/*.yml",
  "deploy/**/*.yaml",
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".circleci/config.yml",
];

const DEP_MANIFESTS = [
  "package.json",
  "pom.xml",
  "requirements.txt",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
];

const TEST_SOURCE_PATTERNS = [
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.spec.tsx",
  "**/*.test.tsx",
  "**/*Test.java",
  "**/*Spec.java",
];

const BUSINESS_SOURCE_PATTERNS = [
  "src/**/*.service.ts",
  "src/**/*.controller.ts",
  "src/**/*.component.ts",
  "src/**/*.service.js",
  "src/**/*.controller.js",
  "src/**/*.ts",
  "src/**/*.js",
  "src/**/*.java",
  "lib/**/*.ts",
  "app/**/*.ts",
];

const MAX_META_BYTES = 8192; // config / package.json cap
const MAX_SAMPLE_BYTES = 6144; // sample code cap

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

async function safeRead(
  filePath: string,
  cap = MAX_META_BYTES,
): Promise<string | null> {
  try {
    const content = await nodefs.readFile(filePath, "utf-8");
    return content.length > cap
      ? content.slice(0, cap) + "\n…[truncated]"
      : content;
  } catch {
    return null;
  }
}

async function readGitIgnorePatterns(baseDir: string): Promise<string[]> {
  try {
    const raw = await nodefs.readFile(
      path.join(baseDir, ".gitignore"),
      "utf-8",
    );
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        let p = l.startsWith("/") ? l.substring(1) : "**/" + l;
        if (p.endsWith("/")) p += "**";
        return p;
      });
  } catch {
    return [];
  }
}

async function buildDirectoryTree(
  baseDir: string,
  maxDepth = 3,
): Promise<string> {
  const lines: string[] = [`📁 ${path.basename(baseDir)}/`];

  async function walk(
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    if (depth > maxDepth) return;
    let entries: string[] = [];
    try {
      entries = await nodefs.readdir(dir);
    } catch {
      return;
    }
    entries = entries.filter((e) => !TREE_SKIP.has(e));
    for (let i = 0; i < entries.length; i++) {
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const entryPath = path.join(dir, entries[i]);
      let stat;
      try {
        stat = await nodefs.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        lines.push(`${prefix}${connector}📁 ${entries[i]}/`);
        await walk(entryPath, prefix + (isLast ? "    " : "│   "), depth + 1);
      } else {
        lines.push(`${prefix}${connector}📄 ${entries[i]}`);
      }
    }
  }

  await walk(baseDir, "", 1);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectScanner — the one place that talks to the filesystem
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Max number of sample test files to include in context. Default: 3 */
  maxSampleTests?: number;
  /** Max number of sample source files to include in context. Default: 5 */
  maxSampleSources?: number;
}

export class ProjectScanner {
  private readonly baseDir: string;
  private readonly opts: Required<ScanOptions>;

  constructor(baseDir: string, opts: ScanOptions = {}) {
    this.baseDir = baseDir;
    this.opts = {
      maxSampleTests: opts.maxSampleTests ?? 3,
      maxSampleSources: opts.maxSampleSources ?? 5,
    };
  }

  // ── Glob helper ────────────────────────────────────────────────────────────

  private glob(
    patterns: string | string[],
    extra: object = {},
  ): Promise<string[]> {
    return fg(patterns, {
      cwd: this.baseDir,
      absolute: true,
      ignore: ["node_modules/**", "dist/**", "build/**", ".git/**"],
      caseSensitiveMatch: false,
      ...extra,
    });
  }

  // ── Individual scan phases ──────────────────────────────────────────────────

  private async scanPackageJson(): Promise<string | null> {
    return safeRead(path.join(this.baseDir, "package.json"));
  }

  private async scanConfigFiles(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, patterns] of Object.entries(CONFIG_CANDIDATES)) {
      const hits = await this.glob(patterns, { deep: 2 });
      if (hits.length > 0) {
        const content = await safeRead(hits[0]);
        if (content) {
          result[key] = `[${path.relative(this.baseDir, hits[0])}]\n${content}`;
        }
      }
    }
    return result;
  }

  private async scanCiFiles(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const hits = await this.glob(CI_PATTERNS, { deep: 3 });
    for (const hit of hits.slice(0, 5)) {
      const content = await safeRead(hit);
      if (content) result[path.relative(this.baseDir, hit)] = content;
    }
    return result;
  }

  private async scanIacFiles(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const hits = await this.glob(IAC_PATTERNS, { deep: 5 });
    for (const hit of hits.slice(0, 20)) {
      const content = await safeRead(hit);
      if (content) result[path.relative(this.baseDir, hit)] = content;
    }
    return result;
  }

  private async scanDependencyManifests(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const manifest of DEP_MANIFESTS) {
      const absPath = path.join(this.baseDir, manifest);
      const content = await safeRead(absPath);
      if (content) result[manifest] = content;
    }
    return result;
  }

  /**
   * Scan all source code files.
   * Respects .gitignore, de-duplicates, returns both raw (for line matching +
   * secrets scan) and optimised (for LLM context) content.
   */
  private async scanCodeFiles(gitIgnores: string[]): Promise<CodeFile[]> {
    const ignoreList = [
      "**/*.spec.*",
      "**/*.test.*",
      "**/__tests__/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
      ...gitIgnores,
    ];

    const hits = await this.glob(CODE_PATTERNS, { ignore: ignoreList });
    const codeFiles: CodeFile[] = [];

    for (const hit of hits) {
      const rawContent = await safeRead(hit, Infinity as unknown as number);
      if (!rawContent) continue;
      codeFiles.push({
        filePath: path.relative(this.baseDir, hit),
        originalContent: rawContent,
        content: optimizeContent(rawContent),
      });
    }

    return codeFiles;
  }

  /**
   * Pick representative test files for skills generation.
   * Prefers files under __tests__ or named *.spec.* / *.test.*
   */
  private async sampleTestFiles(): Promise<
    Array<{ relPath: string; content: string }>
  > {
    const hits = await this.glob(TEST_SOURCE_PATTERNS, { deep: 5 });
    const result: Array<{ relPath: string; content: string }> = [];
    for (const hit of hits.slice(0, this.opts.maxSampleTests)) {
      const content = await safeRead(hit, MAX_SAMPLE_BYTES);
      if (content)
        result.push({ relPath: path.relative(this.baseDir, hit), content });
    }
    return result;
  }

  /**
   * Pick representative business-logic source files for skills generation.
   * Services and controllers come first (most opinionated code).
   */
  private async sampleSourceFiles(
    codeFiles: CodeFile[],
  ): Promise<Array<{ relPath: string; content: string }>> {
    // Prioritise by file name convention (services/controllers most informative)
    const priority = [
      "service",
      "controller",
      "component",
      "handler",
      "resolver",
      "manager",
    ];
    const sorted = [...codeFiles].sort((a, b) => {
      const pa = priority.findIndex((p) =>
        a.filePath.toLowerCase().includes(p),
      );
      const pb = priority.findIndex((p) =>
        b.filePath.toLowerCase().includes(p),
      );
      const ra = pa === -1 ? 999 : pa;
      const rb = pb === -1 ? 999 : pb;
      return ra - rb;
    });

    return sorted.slice(0, this.opts.maxSampleSources).map((f) => ({
      relPath: f.filePath,
      content:
        f.originalContent.length > MAX_SAMPLE_BYTES
          ? f.originalContent.slice(0, MAX_SAMPLE_BYTES) + "\n…[truncated]"
          : f.originalContent,
    }));
  }

  // ── Main entry ─────────────────────────────────────────────────────────────

  /**
   * Run the full project scan and return a `ProjectContext`.
   *
   * Everything is discovered in parallel where possible for speed, then
   * assembled into a single immutable context object.
   */
  async scan(): Promise<ProjectContext> {
    const gitIgnores = await readGitIgnorePatterns(this.baseDir);

    // Phase 1: all metadata in parallel
    const [
      packageJson,
      directoryTree,
      configFiles,
      ciFiles,
      iacFiles,
      dependencyManifests,
      sampleTests,
    ] = await Promise.all([
      this.scanPackageJson(),
      buildDirectoryTree(this.baseDir, 3),
      this.scanConfigFiles(),
      this.scanCiFiles(),
      this.scanIacFiles(),
      this.scanDependencyManifests(),
      this.sampleTestFiles(),
    ]);

    // Phase 2: code files (depends on gitIgnores, but not on phase 1)
    const codeFiles = await this.scanCodeFiles(gitIgnores);

    // Phase 3: source samples (depends on codeFiles)
    const sampleSources = await this.sampleSourceFiles(codeFiles);

    // Derived: public exposure heuristic
    const allIacContent = Object.values(iacFiles).concat(
      Object.values(ciFiles),
    );
    const isPublicFacing = detectPublicExposure(allIacContent);

    return {
      baseDir: this.baseDir,
      codeFiles,
      packageJson,
      directoryTree,
      configFiles,
      ciFiles,
      sampleTests,
      sampleSources,
      iacFiles,
      dependencyManifests,
      isPublicFacing,
    };
  }
}
