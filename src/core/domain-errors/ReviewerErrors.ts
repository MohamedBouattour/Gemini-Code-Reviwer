// Copyright 2026 Google LLC

/**
 * Domain errors for the gemini-code-reviewer.
 *
 * Using specific error classes (instead of generic Error objects) lets the CLI
 * presentation layer provide actionable, user-friendly error messages with
 * correct exit codes — without needing to parse error.message strings.
 *
 * All errors live in the Core layer; infrastructure throws them and the CLI
 * catches them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────────────────

/** Base class so callers can catch all domain errors with `instanceof ReviewerError`. */
export class ReviewerError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication & API
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when OAuth credential retrieval or exchange fails. */
export class AuthenticationError extends ReviewerError {}

/** Thrown when the AI API returns a non-2xx response. */
export class ApiError extends ReviewerError {
  constructor(
    message: string,
    public readonly statusCode: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/** Thrown when the AI response cannot be parsed as the expected JSON shape. */
export class AiResponseParseError extends ReviewerError {}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem & Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the project directory cannot be read. */
export class FileScanError extends ReviewerError {}

/** Thrown when no source files are found in the target directory. */
export class NoSourceFilesError extends ReviewerError {}

/** Thrown when the Google Cloud project cannot be resolved. */
export class ProjectResolutionError extends ReviewerError {}

// ─────────────────────────────────────────────────────────────────────────────
// Review pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when ALL AI batches fail (partial failures are tolerated). */
export class AllBatchesFailedError extends ReviewerError {}
