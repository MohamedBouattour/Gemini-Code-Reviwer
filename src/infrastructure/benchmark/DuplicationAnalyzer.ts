// Copyright 2026 Google LLC

/**
 * DuplicationAnalyzer — detects copy-pasted code blocks across all files.
 *
 * SRP: ONLY responsibility is duplication measurement.
 *
 * ## Algorithm (rolling-hash / line-fingerprint)
 *
 *   1. Normalise each source line: strip leading/trailing whitespace, collapse
 *      internal runs of whitespace to a single space, drop blank/comment lines.
 *      This makes duplication detection whitespace-agnostic.
 *
 *   2. Build a rolling window of MIN_BLOCK_LINES consecutive normalised lines.
 *      Hash each window with a simple djb2 hash.
 *
 *   3. Group windows by hash. Any hash that appears in ≥ 2 different locations
 *      (different files OR same file at a different line) is a duplicate block.
 *
 *   4. Compute duplication percentage as:
 *      (lines covered by at least one duplicate block) / total non-blank lines.
 *
 * ## Performance
 *   O(N × W) where N = total lines, W = window size (default 6).
 *   Typically < 50 ms on a 10 000-line codebase.
 */

import type { CodeSegment } from "../../core/entities/CodeSegment.js";
import type {
  DuplicationReport,
  DuplicateBlock,
} from "../../core/entities/CodeBenchmarkResults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum consecutive lines to consider a duplicate block. */
const MIN_BLOCK_LINES = 6;

/** Maximum number of top duplicate blocks to include in the report. */
const MAX_TOP_BLOCKS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// DuplicationAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

/** Internal representation of a normalised source line. */
interface NormalisedLine {
  filePath: string;
  originalLine: number; // 1-indexed
  text: string;         // normalised content
}

export class DuplicationAnalyzer {
  analyze(files: CodeSegment[]): DuplicationReport {
    // Step 1: Normalise all lines across all files
    const allLines: NormalisedLine[] = [];
    for (const file of files) {
      const fileLines = file.originalContent.split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        const normalised = this.normaliseLine(fileLines[i]);
        if (normalised) {
          allLines.push({
            filePath: file.filePath,
            originalLine: i + 1,
            text: normalised,
          });
        }
      }
    }

    const totalLines = allLines.length;
    if (totalLines < MIN_BLOCK_LINES) {
      return {
        duplicationPercentage: 0,
        totalLines,
        duplicatedLines: 0,
        topBlocks: [],
      };
    }

    // Step 2: Build rolling windows and group by hash
    // Map<hash, locations[]>
    const windowMap = new Map<string, Array<{ filePath: string; startLine: number }>>(
    );

    for (let i = 0; i <= allLines.length - MIN_BLOCK_LINES; i++) {
      const window = allLines.slice(i, i + MIN_BLOCK_LINES);
      const hash = this.hashWindow(window.map((l) => l.text));
      const location = {
        filePath: window[0].filePath,
        startLine: window[0].originalLine,
      };
      const existing = windowMap.get(hash);
      if (existing) {
        // Avoid duplicate entries for the same file+line
        const alreadyRecorded = existing.some(
          (e) => e.filePath === location.filePath && e.startLine === location.startLine,
        );
        if (!alreadyRecorded) existing.push(location);
      } else {
        windowMap.set(hash, [location]);
      }
    }

    // Step 3: Collect only windows that appear in >= 2 locations
    const duplicateBlocks: DuplicateBlock[] = [];
    const duplicatedLineSet = new Set<string>(); // "filePath:lineNum"

    for (const [hash, locations] of windowMap.entries()) {
      if (locations.length < 2) continue;

      duplicateBlocks.push({
        hash,
        lines: MIN_BLOCK_LINES,
        locations,
      });

      // Mark all lines in all occurrences of this block as duplicated
      for (const loc of locations) {
        for (let offset = 0; offset < MIN_BLOCK_LINES; offset++) {
          duplicatedLineSet.add(`${loc.filePath}:${loc.startLine + offset}`);
        }
      }
    }

    const duplicatedLines = duplicatedLineSet.size;
    const duplicationPercentage =
      totalLines > 0
        ? Math.round((duplicatedLines / totalLines) * 1000) / 10 // 1 decimal
        : 0;

    // Step 4: Sort by impact (lines * occurrences) and cap
    const topBlocks = duplicateBlocks
      .sort((a, b) => b.lines * b.locations.length - a.lines * a.locations.length)
      .slice(0, MAX_TOP_BLOCKS);

    return {
      duplicationPercentage,
      totalLines,
      duplicatedLines,
      topBlocks,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  /**
   * Normalise a single source line:
   * - Trim whitespace
   * - Collapse internal whitespace runs to a single space
   * - Drop pure comment lines (// ... or # ...)
   * - Drop blank lines
   * Returns empty string for lines that should be skipped.
   */
  private normaliseLine(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) return "";
    if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return "";
    return trimmed.replace(/\s+/g, " ");
  }

  /**
   * Simple djb2 hash over an array of strings.
   * Fast and collision-resistant enough for this use case.
   */
  private hashWindow(lines: string[]): string {
    const joined = lines.join("\x00");
    let hash = 5381;
    for (let i = 0; i < joined.length; i++) {
      hash = ((hash << 5) + hash) ^ joined.charCodeAt(i);
      hash = hash >>> 0; // keep unsigned 32-bit
    }
    return hash.toString(16).padStart(8, "0");
  }
}
