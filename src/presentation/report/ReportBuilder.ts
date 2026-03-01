// Copyright 2026 Google LLC

/**
 * ReportBuilder — implements IReportBuilder.
 *
 * Single class responsible for:
 *   1. Aggregation    — grouping identical/similar findings across files.
 *   2. Scoring        — deterministic Priority-Weight formula (not AI averaging).
 *   3. Rendering      — building the full Markdown report.
 *
 * ## Clean Architecture compliance
 *   - Imports ONLY from core/entities/ and core/interfaces/.
 *   - Zero imports from legacy security-scanner.ts or infra-auditor.ts.
 *   - SecretFindingEntity and InfraFindingEntity are the canonical domain types.
 */

import chalk from "chalk";

import type {
  IReportBuilder,
  InfrastructureResults,
} from "../../core/interfaces/IReportBuilder.js";
import type { ReviewFinding } from "../../core/entities/ReviewFinding.js";
import type {
  SecretFindingEntity,
  InfraFindingEntity,
  ExecutiveSummary,
  AiSubScores,
  TimingStats,
} from "../../core/entities/ProjectReport.js";
import type { CodeBenchmarkResults } from "../../core/entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatibility type aliases
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use ReviewFinding from core/entities */
export type CodeFinding = ReviewFinding;
/** @deprecated Use ExecutiveSummary from core/entities */
export type { ExecutiveSummary } from "../../core/entities/ProjectReport.js";
/** @deprecated Use ReviewFinding from core/entities */
export type RawFinding = ReviewFinding;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility type (used for JSON state cache in reviewer.ts)
// SecretFindingEntity and InfraFindingEntity are now the canonical Core types.
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeReviewResponse {
  score: number;
  namingConventionScore?: number;
  solidPrinciplesScore?: number;
  codeDuplicationPercentage: number;
  cyclomaticComplexity: number;
  maintainabilityIndex: number;
  findings: CodeFinding[];
  secretFindings?: SecretFindingEntity[];
  infraFindings?: InfraFindingEntity[];
  executiveSummary?: ExecutiveSummary;
  isPublicFacing?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: InfraResultState (replaces InfraAuditResult from infra-auditor.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Internal state mirroring InfrastructureResults — no legacy type import needed. */
interface InfraResultState {
  findings: InfraFindingEntity[];
  isPublicFacing: boolean;
  scannedFiles: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: AggregatedFinding
// ─────────────────────────────────────────────────────────────────────────────

interface AggregatedFinding {
  suggestion: string;
  category?: string;
  priority: "low" | "medium" | "high";
  occurrences: Array<{ file: string; line: number; snippet: string }>;
  recommendedFix?: { before: string; after: string };
  maxRiskMultiplier?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority-Weight scoring constants
// ─────────────────────────────────────────────────────────────────────────────

/** Points deducted per unique aggregated code finding (post-deduplication). */
const CODE_FINDING_WEIGHTS: Record<string, number> = {
  high: 10,
  medium: 3,
  low: 1,
};

/** Points deducted per secret detected. */
const SECRET_WEIGHTS: Record<string, number> = {
  critical: 20,
  high: 10,
  medium: 5,
  low: 2,
};

/** Points deducted per IaC / SCA finding. */
const INFRA_WEIGHTS: Record<string, number> = {
  critical: 20,
  high: 10,
  medium: 5,
  low: 1,
};

const PRIORITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a normalisation key for grouping identical/similar findings.
 * Two findings are "the same issue" when their category and the first 70
 * normalised characters of their suggestion match.
 */
function buildAggKey(f: CodeFinding): string {
  const cat = (f.category ?? "other")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .slice(0, 30);
  const norm = (f.suggestion ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return `${cat}::${norm}`;
}

/**
 * Aggregate raw findings: identical issue across N files → one entry with
 * an occurrences[] list.  Also deduplicates exact file:line duplicates.
 */
function aggregateFindings(findings: CodeFinding[]): AggregatedFinding[] {
  const groups = new Map<string, AggregatedFinding>();

  for (const f of findings) {
    const key = buildAggKey(f);
    const existing = groups.get(key);

    if (existing) {
      const alreadyPresent = existing.occurrences.some(
        (o) => o.file === f.file && o.line === f.line,
      );
      if (!alreadyPresent) {
        existing.occurrences.push({
          file: f.file,
          line: f.line,
          snippet: f.snippet,
        });
      }
      // Escalate to highest observed priority
      if (
        (PRIORITY_ORDER[f.priority] ?? 0) >
        (PRIORITY_ORDER[existing.priority] ?? 0)
      ) {
        existing.priority = f.priority;
        existing.suggestion = f.suggestion; // prefer higher-priority wording
      }
      if (!existing.recommendedFix && f.recommendedFix) {
        existing.recommendedFix = f.recommendedFix;
      }
      const m = f.riskMultiplier ?? 1;
      if (m > (existing.maxRiskMultiplier ?? 1)) {
        existing.maxRiskMultiplier = m;
      }
    } else {
      groups.set(key, {
        suggestion: f.suggestion,
        category: f.category,
        priority: f.priority,
        occurrences: [{ file: f.file, line: f.line, snippet: f.snippet }],
        recommendedFix: f.recommendedFix,
        maxRiskMultiplier: f.riskMultiplier,
      });
    }
  }

  // Sort: high → medium → low, then by occurrences desc
  return Array.from(groups.values()).sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 0;
    const pb = PRIORITY_ORDER[b.priority] ?? 0;
    if (pa !== pb) return pb - pa;
    return b.occurrences.length - a.occurrences.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

function priorityEmoji(p: string): string {
  return p === "high" ? "🟠" : p === "medium" ? "🟡" : "🔵";
}

function severityEmoji(s: string): string {
  return s === "critical"
    ? "🔴"
    : s === "high"
      ? "🟠"
      : s === "medium"
        ? "🟡"
        : "🔵";
}

function priorityBadge(p: string, useChalk: boolean): string {
  const b = `[${p.toUpperCase()}]`;
  if (!useChalk) return b;
  return p === "high"
    ? chalk.red.bold(b)
    : p === "medium"
      ? chalk.yellow(b)
      : chalk.dim(b);
}

function severityBadge(s: string, useChalk: boolean): string {
  const b = `[${s.toUpperCase()}]`;
  if (!useChalk) return b;
  if (s === "critical") return chalk.bgRed.white(b);
  if (s === "high") return chalk.red.bold(b);
  if (s === "medium") return chalk.yellow(b);
  return chalk.dim(b);
}

/** 🟢 Low Risk | 🟡 Moderate | 🟠 High Risk | 🔴 Critical */
function riskLevelLabel(score: number | undefined): string {
  if (score === undefined) return "—";
  if (score >= 80) return "🟢 Low Risk";
  if (score >= 60) return "🟡 Moderate";
  if (score >= 40) return "🟠 High Risk";
  return "🔴 Critical";
}

function formatScore(score: number | undefined, useChalk: boolean): string {
  if (score === undefined) return "N/A";
  const text = `${Math.round(score)}/100`;
  if (!useChalk) return text;
  return score < 50
    ? chalk.red(text)
    : score < 70
      ? chalk.yellow(text)
      : chalk.green(text);
}

/** Render a ```diff Fix-It block. */
function renderFixBlock(
  fix: { before?: string; after?: string },
  useChalk: boolean,
): string {
  if (!fix || typeof fix.before !== "string" || typeof fix.after !== "string") {
    return "";
  }

  const beforeLines = fix.before.split("\n").map((l) => `- ${l}`);
  const afterLines = fix.after.split("\n").map((l) => `+ ${l}`);
  const allLines = [...beforeLines, ...afterLines];

  if (useChalk) {
    const coloured = allLines
      .map((l) =>
        l.startsWith("- ")
          ? chalk.red(l)
          : l.startsWith("+ ")
            ? chalk.green(l)
            : l,
      )
      .join("\n");
    return `\n**💊 Recommended Fix:**\n\`\`\`diff\n${coloured}\n\`\`\`\n`;
  }
  return `\n**💊 Recommended Fix:**\n\`\`\`diff\n${allLines.join("\n")}\n\`\`\`\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers (pure functions — no state)
// ─────────────────────────────────────────────────────────────────────────────

function renderExecutiveSummary(
  summary: ExecutiveSummary,
  useChalk: boolean,
): string {
  let out = "## 📋 Executive Summary\n\n";
  if (summary.isPublicFacing) {
    const w =
      "⚠️  This project is INTERNET-FACING — score penalties are amplified.";
    out += useChalk ? chalk.red.bold(w) + "\n\n" : `> **${w}**\n\n`;
  }
  out += `### 🔍 The What\n${summary.what}\n\n`;
  out += `### 💥 The Impact\n${summary.impact}\n\n`;
  out += `### 🚨 The Risk\n${summary.risk}\n\n`;
  out += "---\n\n";
  return out;
}

function renderScoreTable(
  overallScore: number,
  aiScores: AiSubScores | undefined,
  localBenchmarks: CodeBenchmarkResults | undefined,
  isPublicFacing: boolean,
  useChalk: boolean,
): string {
  let out = "## 📊 Scores\n\n";
  out += "| Metric | Score | Risk Level |\n|:---|:---:|:---:|\n";

  out += `| **Overall (Priority-Weighted)** | ${formatScore(overallScore, useChalk)} | ${riskLevelLabel(overallScore)} |\n`;

  // Prefer local benchmarks over legacy AI scores for better accuracy
  const namingScoreSummary =
    localBenchmarks?.naming.score ?? aiScores?.namingConventionScore;
  const duplicationSummary =
    localBenchmarks?.duplication.duplicationPercentage ??
    aiScores?.codeDuplicationPercentage;
  const complexitySummary =
    localBenchmarks?.complexity.averageComplexity ??
    aiScores?.cyclomaticComplexity;
  const maintainabilitySummary = aiScores?.maintainabilityIndex;
  const solidSummary = aiScores?.solidPrinciplesScore;

  if (namingScoreSummary !== undefined) {
    const src = localBenchmarks?.naming ? "local" : "AI";
    out += `| Naming Conventions *(${src})* | ${formatScore(namingScoreSummary, useChalk)} | — |\n`;
  }
  if (solidSummary !== undefined) {
    out += `| SOLID Principles *(AI)* | ${formatScore(solidSummary, useChalk)} | — |\n`;
  }
  if (maintainabilitySummary !== undefined) {
    out += `| Maintainability Index | ${formatScore(maintainabilitySummary, useChalk)} | — |\n`;
  }
  if (duplicationSummary !== undefined) {
    out += `| Code Duplication | ${duplicationSummary.toFixed(1)}% | — |\n`;
  }
  if (complexitySummary !== undefined) {
    out += `| Avg Cyclomatic Complexity | ${complexitySummary.toFixed(1)} | — |\n`;
  }
  out += "\n";

  if (isPublicFacing) {
    const note =
      "🌐 Internet-facing architecture detected — score uses ×0.93 exposure penalty.";
    out += useChalk ? chalk.yellow(note) + "\n\n" : `> ${note}\n\n`;
  }
  return out;
}

function renderSecretFindings(
  findings: SecretFindingEntity[],
  useChalk: boolean,
): string {
  if (findings.length === 0) return "";
  let out = "## 🔐 Secrets & Credentials Detected\n\n";
  out +=
    "> **⚠️ Rotate these immediately.** Hardcoded credentials were detected locally " +
    "(before any LLM call). Migrate to AWS Secrets Manager, HashiCorp Vault, " +
    "or Google Secret Manager.\n\n";
  for (const [i, f] of findings.entries()) {
    out += `### S${i + 1}. ${severityEmoji(f.severity)} ${severityBadge(f.severity, useChalk)} \`${f.file}\` (Line: ${f.line})\n`;
    out += `**Type:** ${f.label}  \n`;
    out += `**Pattern:** \`${f.snippet}\`\n\n---\n\n`;
  }
  return out;
}

function renderInfraFindings(
  findings: InfraFindingEntity[],
  scannedFiles: string[],
  useChalk: boolean,
): string {
  if (findings.length === 0 && scannedFiles.length === 0) return "";
  let out = "## 🏗️ Infrastructure & Dependency Audit\n\n";

  if (scannedFiles.length > 0) {
    out += `**Scanned:** ${scannedFiles.map((f) => `\`${f}\``).join(", ")}\n\n`;
  }
  if (findings.length === 0) {
    return out + "*No infrastructure misconfigurations found.* ✅\n\n";
  }

  const high = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );
  const medium = findings.filter((f) => f.severity === "medium");
  const low = findings.filter((f) => f.severity === "low");

  let idx = 1;
  const renderInfra = (
    f: InfraFindingEntity,
    i: number,
    collapse: boolean,
  ): string => {
    const emoji = severityEmoji(f.severity);
    const badge = severityBadge(f.severity, useChalk);
    const lineRef = f.line ? ` (Line: ${f.line})` : "";
    const heading = `I${i}. ${emoji} ${badge} \`${f.file}\`${lineRef} — ${f.title}`;
    const body = `**Category:** ${f.category}\n\n${f.description}\n\n**Remediation:** ${f.remediation}\n\n---\n\n`;
    return collapse
      ? `<details>\n<summary>${heading}</summary>\n\n${body}</details>\n\n`
      : `### ${heading}\n\n${body}`;
  };

  for (const f of high) {
    out += renderInfra(f, idx++, false);
  }
  for (const f of medium) {
    out += renderInfra(f, idx++, true);
  }
  for (const f of low) {
    out += renderInfra(f, idx++, true);
  }

  return out;
}

function renderCodeFindings(
  aggregated: AggregatedFinding[],
  useChalk: boolean,
): string {
  if (aggregated.length === 0) {
    return "*No code findings! Excellent code structure.* ✅\n\n";
  }

  let out = "## 🕵️ Code Review Findings\n\n";

  const highCount = aggregated.filter((f) => f.priority === "high").length;
  const mediumCount = aggregated.filter((f) => f.priority === "medium").length;
  const lowCount = aggregated.filter((f) => f.priority === "low").length;
  const totalOccs = aggregated.reduce((s, f) => s + f.occurrences.length, 0);
  const merged = totalOccs - aggregated.length;

  out += `> **${aggregated.length} unique issue(s)** `;
  out += `— 🟠 ${highCount} high &nbsp; 🟡 ${mediumCount} medium &nbsp; 🔵 ${lowCount} low`;
  if (merged > 0) out += ` &nbsp; _(${merged} duplicate occurrence(s) merged)_`;
  out += "\n\n";

  const highFindings = aggregated.filter((f) => f.priority === "high");
  const mediumFindings = aggregated.filter((f) => f.priority === "medium");
  const lowFindings = aggregated.filter((f) => f.priority === "low");
  let idx = 1;

  // HIGH — expanded
  for (const agg of highFindings) {
    const emoji = priorityEmoji("high");
    const badge = priorityBadge("high", useChalk);
    const catTag = agg.category ? ` **[${agg.category}]**` : "";
    const mux = agg.maxRiskMultiplier ?? 1;
    const riskTag =
      mux >= 1.8
        ? " ⚡ _internet-facing_"
        : mux >= 1.5
          ? " ⚡ _high-exposure_"
          : "";

    if (agg.occurrences.length === 1) {
      const o = agg.occurrences[0];
      out += `### ${idx}. ${emoji} ${badge}${catTag} \`${o.file}\` (Line: ${o.line})${riskTag}\n\n`;
      out += `**Code Snippet:**\n\`\`\`\n${o.snippet}\n\`\`\`\n`;
    } else {
      out += `### ${idx}. ${emoji} ${badge}${catTag} — ${agg.occurrences.length} locations${riskTag}\n\n`;
      out += "**Affected locations:**\n\n";
      out += "| File | Line | Snippet |\n|:---|:---:|:---|\n";
      for (const o of agg.occurrences) {
        out += `| \`${o.file}\` | ${o.line} | \`${o.snippet.slice(0, 60)}\` |\n`;
      }
      out += "\n";
    }
    out += `**Issue:**\n${agg.suggestion}\n`;
    if (agg.recommendedFix) {
      out += renderFixBlock(agg.recommendedFix, useChalk);
    }
    out += "\n---\n\n";
    idx++;
  }

  // MEDIUM — collapsed
  for (const agg of mediumFindings) {
    const catTag = agg.category ? ` [${agg.category}]` : "";
    const primary = agg.occurrences[0];
    const extra =
      agg.occurrences.length > 1
        ? ` (+${agg.occurrences.length - 1} more)`
        : "";
    const summary = `${idx}. 🟡 [MEDIUM]${catTag} — \`${primary.file}:${primary.line}\`${extra}`;

    out += `<details>\n<summary>${summary}</summary>\n\n`;
    if (agg.occurrences.length === 1) {
      out += `**Code Snippet:**\n\`\`\`\n${primary.snippet}\n\`\`\`\n\n`;
    } else {
      out += "**Affected locations:**\n\n| File | Line |\n|:---|:---:|\n";
      for (const o of agg.occurrences) out += `| \`${o.file}\` | ${o.line} |\n`;
      out += `\n**Primary Snippet:**\n\`\`\`\n${primary.snippet}\n\`\`\`\n\n`;
    }
    out += `**Issue:**\n${agg.suggestion}\n`;
    if (agg.recommendedFix) out += renderFixBlock(agg.recommendedFix, useChalk);
    out += "\n</details>\n\n";
    idx++;
  }

  // LOW — all in one collapsible block
  if (lowFindings.length > 0) {
    out += `<details>\n<summary>🔵 ${lowFindings.length} LOW-priority finding${lowFindings.length > 1 ? "s" : ""} (click to expand)</summary>\n\n`;
    for (const agg of lowFindings) {
      const catTag = agg.category ? ` [${agg.category}]` : "";
      const primary = agg.occurrences[0];
      const extra =
        agg.occurrences.length > 1
          ? ` (+${agg.occurrences.length - 1} more)`
          : "";
      out += `#### ${idx}.${catTag} \`${primary.file}:${primary.line}\`${extra}\n\n`;
      if (agg.occurrences.length > 1) {
        out +=
          "Affected: " +
          agg.occurrences.map((o) => `\`${o.file}:${o.line}\``).join(", ") +
          "\n\n";
      } else {
        out += `**Snippet:** \`${primary.snippet.slice(0, 80)}\`\n\n`;
      }
      out += `${agg.suggestion}\n\n---\n\n`;
      idx++;
    }
    out += "</details>\n\n";
  }

  return out;
}

function renderLocalBenchmarkDetails(
  benchmarks: CodeBenchmarkResults | undefined,
): string {
  if (!benchmarks) return "";

  let out = "## 📈 Project Metrics (Local Analysis)\n\n";

  // Complexity
  out += `### 🧩 Complexity\n`;
  out += `- **Average Cyclomatic Complexity:** ${benchmarks.complexity.averageComplexity.toFixed(2)}\n`;
  out += `- **Maximum Complexity Found:** ${benchmarks.complexity.maxComplexity}\n`;
  out += `- **Total Functions Analysed:** ${benchmarks.complexity.totalFunctions}\n`;
  out += `- **Complexity Hotspots:** ${benchmarks.complexity.hotspots.length}\n\n`;

  // Duplication
  out += `### 👯 Duplication\n`;
  out += `- **Duplication Percentage:** ${benchmarks.duplication.duplicationPercentage.toFixed(1)}%\n`;
  out += `- **Duplicated Lines:** ${benchmarks.duplication.duplicatedLines} / ${benchmarks.duplication.totalLines}\n`;
  out += `- **Top Duplicate Blocks:** ${benchmarks.duplication.topBlocks.length}\n\n`;

  // Naming
  out += `### 🏷️ Naming Conventions\n`;
  out += `- **Score:** ${benchmarks.naming.score}/100\n`;
  out += `- **Identifiers Checked:** ${benchmarks.naming.totalChecked}\n`;
  out += `- **Violations Found:** ${benchmarks.naming.totalViolations}\n\n`;

  out += "---\n\n";
  return out;
}

function renderTimingStats(stats: TimingStats): string {
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  let out = "## ⏱️ Pipeline Timing\n\n";
  out += "| Phase | Duration |\n|:---|---:|\n";
  out += `| 🔍 File scan + hashing      | ${fmt(stats.scanMs)} |\n`;

  if (stats.auditInfraMs !== undefined && stats.deepReviewMs !== undefined) {
    out += `| 🤖 auditInfra (Call 1)      | ${fmt(stats.auditInfraMs)} |\n`;
    out += `| 🤖 deepReview  (Call 2)     | ${fmt(stats.deepReviewMs)} |\n`;
  } else {
    out += `| 🤖 AI audit + deep review   | ${fmt(stats.auditMs)} |\n`;
  }

  out += `| 📝 Executive summary        | ${fmt(stats.summaryMs)} |\n`;
  out += `| **⏳ Total**                 | **${fmt(stats.totalMs)}** |\n`;
  out += "\n";
  out += `_Reviewed on ${stats.timestamp}_\n\n`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReportBuilder — main class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ReportBuilder
 *
 * Usage in reviewer.ts (ReviewCodeUseCase):
 * ```ts
 * const builder = new ReportBuilder();
 *
 * builder.addAiFindings(filteredFindings);          // after all segments
 * builder.addSecretResults(secretFindings);          // pre-scan results
 * builder.addInfrastructureResults(infraResult);    // IaC/SCA audit
 * builder.setExecutiveSummary(executiveSummary);    // AI prose summary
 * builder.setAiScores({ namingConventionScore, … }); // sub-scores
 *
 * const finalScore  = builder.calculateFinalScore(); // cache this
 * const consoleOut  = builder.build(true);           // chalk colours
 * const markdownOut = builder.build(false);           // plain markdown
 * ```
 */
export class ReportBuilder implements IReportBuilder {
  private rawFindings: CodeFinding[] = [];
  private aggregated: AggregatedFinding[] = [];
  private infraResult: InfraResultState = {
    findings: [],
    isPublicFacing: false,
    scannedFiles: [],
  };
  private secrets: SecretFindingEntity[] = [];
  private executiveSummary?: ExecutiveSummary;
  private aiScores?: AiSubScores;
  private localBenchmarks?: CodeBenchmarkResults;
  private timingStats?: TimingStats;

  // ── IReportBuilder implementation ─────────────────────────────────────────

  /**
   * Ingest raw AI findings.
   * Deduplication (logDebug repeats, auth duplicates, etc.) runs immediately
   * so each subsequent `calculateFinalScore()` call reflects the current state.
   */
  addAiFindings(findings: RawFinding[]): void {
    this.rawFindings.push(...findings);
    this.aggregated = aggregateFindings(this.rawFindings);
  }

  addInfrastructureResults(results: InfrastructureResults): void {
    // InfrastructureResults and InfraResultState are structurally identical.
    this.infraResult = results;
  }

  addSecretResults(secrets: SecretFindingEntity[]): void {
    // SecretFindingEntity is the canonical Core type. No cast needed.
    this.secrets = secrets;
  }

  setExecutiveSummary(summary: ExecutiveSummary): void {
    this.executiveSummary = summary;
  }

  setAiScores(scores: AiSubScores): void {
    this.aiScores = scores;
  }

  setLocalBenchmarks(benchmarks: CodeBenchmarkResults): void {
    this.localBenchmarks = benchmarks;
  }

  setTimingStats(stats: TimingStats): void {
    this.timingStats = stats;
  }

  /**
   * Priority-Weight scoring.
   *
   * Deterministic and transparent — every penalty point is traceable to a
   * specific finding.  Replaces the unreliable "average AI batch score"
   * approach, which fluctuated based on chunk boundaries.
   */
  calculateFinalScore(): number {
    let penalty = 0;

    // Code findings — counts unique aggregated issues (not raw per-file duplicates)
    for (const agg of this.aggregated) {
      penalty += CODE_FINDING_WEIGHTS[agg.priority] ?? 1;
    }

    // Secrets
    for (const s of this.secrets) {
      penalty += SECRET_WEIGHTS[s.severity] ?? 5;
    }

    // IaC / SCA findings
    for (const f of this.infraResult.findings) {
      penalty += INFRA_WEIGHTS[f.severity] ?? 5;
    }

    let score = 100 - penalty;

    // Exposure amplifier
    if (this.infraResult.isPublicFacing) {
      score = Math.round(score * 0.93);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Build the complete Markdown report.
   *
   * Can be called multiple times (e.g., once with `useChalk=true` for console,
   * once with `useChalk=false` for the `.md` file) — the builder is stateless
   * with respect to rendering.
   */
  build(useChalk = false): string {
    const score = this.calculateFinalScore();
    let report = "# 🤖 AI Code Review Report\n\n";

    if (this.executiveSummary) {
      report += renderExecutiveSummary(this.executiveSummary, useChalk);
    }

    report += renderScoreTable(
      score,
      this.aiScores,
      this.localBenchmarks,
      this.infraResult.isPublicFacing,
      useChalk,
    );

    if (this.secrets.length > 0) {
      report += renderSecretFindings(this.secrets, useChalk);
    }

    report += renderInfraFindings(
      this.infraResult.findings,
      this.infraResult.scannedFiles,
      useChalk,
    );

    report += renderCodeFindings(this.aggregated, useChalk);

    if (this.localBenchmarks) {
      report += renderLocalBenchmarkDetails(this.localBenchmarks);
    }

    if (this.timingStats) {
      report += renderTimingStats(this.timingStats);
    }

    return report;
  }

  // ── Convenience: build from a legacy CodeReviewResponse ───────────────────

  /**
   * Populate the builder from a `CodeReviewResponse` object (e.g., loaded
   * from the JSON cache).  Enables using the builder for cached report rendering.
   */
  static fromCachedResponse(data: CodeReviewResponse): ReportBuilder {
    const builder = new ReportBuilder();
    builder.addAiFindings(data.findings ?? []);
    builder.addSecretResults(data.secretFindings ?? []);
    builder.addInfrastructureResults({
      findings: data.infraFindings ?? [],
      isPublicFacing: data.isPublicFacing ?? false,
      scannedFiles: [],
    });
    if (data.executiveSummary) {
      builder.setExecutiveSummary(data.executiveSummary);
    }
    builder.setAiScores({
      namingConventionScore: data.namingConventionScore,
      solidPrinciplesScore: data.solidPrinciplesScore,
      codeDuplicationPercentage: data.codeDuplicationPercentage ?? 0,
      cyclomaticComplexity: data.cyclomaticComplexity ?? 0,
      maintainabilityIndex: data.maintainabilityIndex ?? 0,
    });
    return builder;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility function (used by cached-report fast-path in reviewer.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Prefer instantiating `ReportBuilder` directly.
 * Kept for the cached-report fast-path in `reviewer.ts`.
 */
export function generateMarkdownReport(
  data: CodeReviewResponse,
  useChalk = false,
): string {
  return ReportBuilder.fromCachedResponse(data).build(useChalk);
}
