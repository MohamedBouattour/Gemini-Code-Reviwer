// Copyright 2026 Google LLC

/**
 * AiCallLogger — debug persistence layer for AI calls.
 *
 * When debug mode is enabled, every call made through GeminiProvider is
 * persisted as a JSON file under `.gemini-code-reviewer/` in the CWD.
 *
 * ## File naming
 *   .gemini-code-reviewer/<ISO-timestamp>_<callName>.json
 *   Example: .gemini-code-reviewer/2026-02-28T05-01-00-000Z_auditInfra.json
 *
 * ## File structure
 * ```json
 * {
 *   "call":        "auditInfra",
 *   "model":       "gemini-2.5-flash",
 *   "timestamp":   "2026-02-28T05:01:00.000Z",
 *   "durationMs":  1243,
 *   "estimatedInputTokens": 4200,
 *   "payload":     { ...full request body sent to Gemini... },
 *   "response":    { ...full parsed JSON response... }
 * }
 * ```
 *
 * Files are written fire-and-forget (errors are swallowed and logged via
 * logDebug so they never break the main review flow).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LogDebugFn } from "../../shared/utils/Logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AiCallRecord {
  call: string;
  model: string;
  timestamp: string;
  durationMs: number;
  estimatedInputTokens: number;
  payload: unknown;
  response: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AI_CALL_LOG_DIR = ".gemini-code-reviewer";

// ─────────────────────────────────────────────────────────────────────────────
// AiCallLogger
// ─────────────────────────────────────────────────────────────────────────────

export class AiCallLogger {
  private readonly enabled: boolean;
  private readonly logDir: string;
  private readonly logDebug: LogDebugFn;

  constructor(enabled: boolean, logDebug: LogDebugFn, baseDir = process.cwd()) {
    this.enabled = enabled;
    this.logDir = path.join(baseDir, AI_CALL_LOG_DIR);
    this.logDebug = logDebug;
  }

  /**
   * Persist one AI call record to disk.
   *
   * Fire-and-forget: never throws, never blocks the caller.
   * Filename format: <ISO-timestamp-safe>_<callName>.json
   */
  persist(
    callName: string,
    model: string,
    payload: unknown,
    response: unknown,
    durationMs: number,
    estimatedInputTokens: number,
  ): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    // Make ISO timestamp safe for filenames: replace `:` and `.` with `-`
    const safeTs = timestamp.replace(/[:.]/g, "-");
    const filename = `${safeTs}_${callName}.json`;
    const filePath = path.join(this.logDir, filename);

    const record: AiCallRecord = {
      call: callName,
      model,
      timestamp,
      durationMs,
      estimatedInputTokens,
      payload,
      response,
    };

    // Fire-and-forget — intentionally not awaited
    this.writeRecord(filePath, record).catch((err: Error) => {
      this.logDebug(`[AiCallLogger] Failed to write ${filename}: ${err.message}`);
    });

    this.logDebug(
      `[AiCallLogger] Persisting ${callName} → ${path.relative(process.cwd(), filePath)}`,
    );
  }

  private async writeRecord(
    filePath: string,
    record: AiCallRecord,
  ): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  }
}
