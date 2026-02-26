// Copyright 2026 Google LLC

/**
 * Logger — shared debug logging utility.
 *
 * Lives in the Shared layer. Used by the Presentation layer (CLI entry points)
 * to produce a `logDebug` function that is passed down through the Use Cases
 * via Dependency Injection, maintaining Clean Architecture boundaries.
 *
 * ## Why this exists
 * Every CLI command previously inlined the same `logDebug` factory:
 *   `const logDebug = (msg: string) => { if (options.debug) console.log(...) };`
 * This module eliminates that duplication.
 *
 * ## Usage
 * ```ts
 * import { createLogger } from '../../shared/utils/Logger.js';
 * const logDebug = createLogger(options.debug);
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Logger type
// ─────────────────────────────────────────────────────────────────────────────

/** A single-argument debug logging function. No-op when debug is disabled. */
export type LogDebugFn = (message: string) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a debug logger.
 *
 * @param enabled  When `true`, messages are printed to stdout with a `[DEBUG]`
 *                 prefix. When `false` (the default), calls are no-ops.
 * @param prefix   Optional prefix to distinguish loggers from multiple components.
 */
export function createLogger(enabled: boolean, prefix = "DEBUG"): LogDebugFn {
  if (!enabled) {
    return () => {};
  }
  return (message: string) => {
    console.log(`\n[${prefix}] ${message}`);
  };
}

/**
 * A permanently silent logger. Useful as a default when no logger
 * is injected (e.g., in unit tests).
 */
export const noopLogger: LogDebugFn = () => {};
