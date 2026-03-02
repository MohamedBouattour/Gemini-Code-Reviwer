// Copyright 2026 Google LLC

/**
 * FeedbackStore — AI Feedback Loop for false-positive suppression.
 *
 * Migration target: src/feedback.ts → src/infrastructure/persistence/FeedbackStore.ts
 *
 * ## Responsibilities (SRP)
 *   Persist and retrieve user-dismissed findings so the AI model learns
 *   to reduce false positives over time (similar to CodeRabbit's mechanism).
 *
 * ## Storage
 *   `.reviewer-cache/feedback.json` in the project root.
 *   Keyed by SHA-256(file + ":" + line + ":" + snippet.slice(0, 30)).
 *
 * ## Clean Architecture
 *   - Lives in the Infrastructure/Persistence layer.
 *   - The IFeedbackManager interface (in RunCodeReview.ts) decouples the
 *     Application layer from this filesystem implementation.
 *   - Instantiated in DependencyContainer and passed as IFeedbackManager.
 */

import * as nodefs from "node:fs/promises";
import * as path from "node:path";
import crypto from "node:crypto";
import {
  FEEDBACK_SYSTEM_PROMPT_SUFFIX_INTRO,
  FEEDBACK_SYSTEM_PROMPT_SUFFIX_OUTRO,
} from "../ai/prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Value types
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedbackEntry {
  /** SHA-256 fingerprint of (file + line + snippet prefix). */
  id: string;
  /** ISO timestamp when the user marked this as false positive. */
  markedAt: string;
  /** Source file path. */
  file: string;
  /** Line number. */
  line: number;
  /** First 80 chars of the snippet or suggestion. */
  snippetPreview: string;
  /** Category of the original finding (e.g., "SOLID", "Naming"). */
  category?: string;
  /** Optional user note explaining why this is a false positive. */
  note?: string;
}

export interface FeedbackStoreData {
  version: number;
  entries: FeedbackEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_DIR = ".reviewer-cache";
const FEEDBACK_FILE = "feedback.json";
const CURRENT_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic 16-char fingerprint for a finding.
 * Used to detect duplicates and to match against the false-positive store.
 */
export function fingerprintFinding(
  file: string,
  line: number,
  snippetOrSuggestion: string,
): string {
  const raw = `${file}:${line}:${snippetOrSuggestion.slice(0, 30)}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// FeedbackStore — the infrastructure class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FeedbackStore
 *
 * Implements the IFeedbackManager interface defined in RunCodeReview.ts.
 * Load once at CLI startup (before the review begins), then pass to the
 * DependencyContainer as the feedbackManager dependency.
 *
 * ```ts
 * const feedbackStore = new FeedbackStore(baseDir);
 * await feedbackStore.load();
 * const container = DependencyContainer.create({ ..., feedbackManager: feedbackStore });
 * ```
 */
export class FeedbackStore {
  private readonly storePath: string;
  private store: FeedbackStoreData = { version: CURRENT_VERSION, entries: [] };

  constructor(baseDir: string) {
    this.storePath = path.join(baseDir, CACHE_DIR, FEEDBACK_FILE);
  }

  // ── IFeedbackManager ───────────────────────────────────────────────────────

  /** True if the store has any feedback at all. */
  get hasFeedback(): boolean {
    return this.store.entries.length > 0;
  }

  /**
   * Build the system prompt suffix that tells Gemini which patterns to avoid.
   * Injected into every subsequent review to reduce noise on dismissed patterns.
   */
  buildSystemPromptSuffix(): string {
    if (!this.hasFeedback) return "";

    const lines = [FEEDBACK_SYSTEM_PROMPT_SUFFIX_INTRO];

    for (const entry of this.store.entries) {
      lines.push(
        `- File: \`${entry.file}\` Line: ${entry.line}` +
          (entry.category ? ` Category: ${entry.category}` : "") +
          `\n  Pattern: "${entry.snippetPreview}"` +
          (entry.note ? `\n  Reason: ${entry.note}` : ""),
      );
    }

    lines.push(FEEDBACK_SYSTEM_PROMPT_SUFFIX_OUTRO);

    return lines.join("\n");
  }

  /**
   * Check if a given finding matches any stored false positive.
   * Used to filter out known false positives at report-assembly time.
   */
  isFalsePositive(file: string, line: number, snippet: string): boolean {
    const id = fingerprintFinding(file, line, snippet);
    return this.store.entries.some((e) => e.id === id);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Load the feedback store from disk. Safe — no-ops on missing file. */
  async load(): Promise<void> {
    try {
      const raw = await nodefs.readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as FeedbackStoreData;
      if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.entries)) {
        this.store = parsed;
      }
    } catch {
      this.store = { version: CURRENT_VERSION, entries: [] };
    }
  }

  /** Persist the current store to disk. Best-effort — non-fatal on failure. */
  async save(): Promise<void> {
    try {
      await nodefs.mkdir(path.dirname(this.storePath), { recursive: true });
      await nodefs.writeFile(
        this.storePath,
        JSON.stringify(this.store, null, 2),
        "utf-8",
      );
    } catch {
      /* non-fatal */
    }
  }

  /** Returns all stored false-positive entries. */
  get entries(): FeedbackEntry[] {
    return this.store.entries;
  }

  /**
   * Mark a finding as a false positive and persist it.
   * Called when the user runs: `gemini-code-reviewer --false-positive <id>`
   */
  async markFalsePositive(
    entry: Omit<FeedbackEntry, "id" | "markedAt">,
  ): Promise<FeedbackEntry> {
    await this.load();

    const id = fingerprintFinding(entry.file, entry.line, entry.snippetPreview);
    const existing = this.store.entries.find((e) => e.id === id);

    if (existing) {
      if (entry.note) existing.note = entry.note;
      await this.save();
      return existing;
    }

    const newEntry: FeedbackEntry = {
      id,
      markedAt: new Date().toISOString(),
      ...entry,
    };
    this.store.entries.push(newEntry);
    await this.save();
    return newEntry;
  }
}
