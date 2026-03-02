// Copyright 2026 Google LLC

/**
 * AiCallLogger — persists every AI call payload + response to disk.
 *
 * ## Always-on (not gated by --debug)
 *
 *   Call logs are OPERATIONAL artifacts, not debug artifacts.
 *   They are written on every run so you can always inspect:
 *     - exact prompt sent to Gemini
 *     - exact JSON response received
 *     - per-call wall-clock time (to diagnose slow/retried calls)
 *     - estimated token count
 *     - how many retries were needed
 *
 * ## Output location
 *   <baseDir>/gemini-code-reviewer/ai-calls/<ISO-timestamp>_<callName>.json
 *
 *   Example:
 *     gemini-code-reviewer/ai-calls/2026-02-28T05-01-00-000Z_auditInfra.json
 *     gemini-code-reviewer/ai-calls/2026-02-28T05-01-03-412Z_deepReview.json
 *     gemini-code-reviewer/ai-calls/2026-02-28T05-01-05-891Z_generateExecutiveSummary.json
 *
 * ## Record shape
 * ```json
 * {
 *   "call":                  "auditInfra",
 *   "model":                 "gemini-2.5-flash",
 *   "timestamp":             "2026-02-28T05:01:00.000Z",
 *   "durationMs":            4312,
 *   "retryCount":            0,
 *   "estimatedInputTokens":  820,
 *   "payload":               { ...full request body... },
 *   "response":              { ...full parsed JSON response... }
 * }
 * ```
 *
 * Files are written fire-and-forget: errors are swallowed and emitted as
 * logDebug lines so they never block or crash the main review flow.
 *
 * ## Old behaviour (removed)
 *   Previously `AiCallLogger` was gated by a `debug: boolean` flag and wrote
 *   nothing unless `--debug` was passed. That made it useless for diagnosing
 *   production timing problems. The flag has been removed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AiCallRecord {
  /** IAiProvider method name (e.g. "auditInfra", "deepReview"). */
  call: string;
  /** Gemini model identifier used for this call. */
  model: string;
  /** ISO 8601 timestamp when the call completed. */
  timestamp: string;
  /** Wall-clock duration from first fetch() attempt to successful parse, ms. */
  durationMs: number;
  /**
   * Number of 429 retries consumed before success.
   * 0 = succeeded on first attempt.
   * > 0 = how many times the request was retried after rate-limit.
   */
  retryCount: number;
  /** Rough token estimate: prompt chars ÷ 4. */
  estimatedInputTokens: number;
  /** Full request body sent to the Code Assist API. */
  payload: unknown;
  /** Full parsed JSON response from Gemini. */
  response: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Subdirectory under gemini-code-reviewer/ where call logs live. */
export const AI_CALL_LOG_SUBDIR = "ai-calls";

// ─────────────────────────────────────────────────────────────────────────────
// AiCallLogger
// ─────────────────────────────────────────────────────────────────────────────

export class AiCallLogger {
  private readonly logDir: string;
  private readonly logDebug: (msg: string) => void;

  /**
   * @param outputDir  The review output directory (e.g. `<baseDir>/gemini-code-reviewer`).
   *                   Call logs are written to `<outputDir>/ai-calls/`.
   * @param logDebug   Debug logger — used only for write-failure warnings.
   */
  constructor(outputDir: string, logDebug: (msg: string) => void) {
    this.logDir = path.join(outputDir, AI_CALL_LOG_SUBDIR);
    this.logDebug = logDebug;
  }

  /**
   * Persist one AI call record to `<outputDir>/ai-calls/<ts>_<callName>.json`.
   *
   * Always writes — fire-and-forget, never throws.
   */
  persist(
    callName: string,
    model: string,
    payload: unknown,
    response: unknown,
    durationMs: number,
    estimatedInputTokens: number,
    retryCount = 0,
  ): void {
    const timestamp = new Date().toISOString();
    const safeTs = timestamp.replace(/[:.]/g, "-");
    const filename = `${safeTs}_${callName}.json`;
    const filePath = path.join(this.logDir, filename);

    const record: AiCallRecord = {
      call: callName,
      model,
      timestamp,
      durationMs,
      retryCount,
      estimatedInputTokens,
      payload,
      response,
    };

    // Fire-and-forget — intentionally not awaited
    this.writeRecord(filePath, record).catch((err: Error) => {
      this.logDebug(`[AiCallLogger] Failed to write ${filename}: ${err.message}`);
    });

    this.logDebug(
      `[AiCallLogger] → ${path.relative(process.cwd(), filePath)}` +
        ` (${durationMs}ms, ~${estimatedInputTokens} tokens, retries=${retryCount})`,
    );
  }

  private async writeRecord(filePath: string, record: AiCallRecord): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  }
}
