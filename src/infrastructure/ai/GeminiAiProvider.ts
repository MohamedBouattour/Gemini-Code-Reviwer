// Copyright 2026 Google LLC

/**
 * GeminiAiProvider — canonical Clean Architecture location for the Gemini AI adapter.
 *
 * This is the target file described in the migration plan:
 *   src/api.ts → src/infrastructure/ai/GeminiAiProvider.ts
 *
 * The complete implementation lives in GeminiProvider.ts (same directory).
 * This module re-exports the class and types under the architecturally-correct
 * name "GeminiAiProvider" so that the Dependency Container and any future
 * code can import from the canonical path without breaking existing infrastructure.
 *
 * @see GeminiProvider.ts — the full implementation
 */

export { GeminiProvider as GeminiAiProvider } from "./GeminiProvider.js";
