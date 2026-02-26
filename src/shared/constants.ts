// Copyright 2026 Google LLC

/**
 * shared/constants.ts — canonical global constants for the entire application.
 *
 * Lives in the Shared layer — imported by all layers (Core, Application,
 * Infrastructure, Presentation). Contains no layer-specific logic.
 *
 * Migration note: src/constants.ts is now a backward-compat re-export shim
 * that points here. All new code should import from 'src/shared/constants.js'.
 */

// ─────────────────────────────────────────────────────────────────────────────
// AI Model identifiers
// ─────────────────────────────────────────────────────────────────────────────

export enum GeminiModel {
  FLASH = "gemini-2.5-flash",
  PRO = "gemini-2.5-pro",
}

// ─────────────────────────────────────────────────────────────────────────────
// Token / payload thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Character limit per deep-review chunk (≈5k tokens).
 * The chunked pipeline splits the codebase into pieces of this size
 * so each AI call stays fast and focused.
 */
export const CHUNK_CHAR_THRESHOLD = 20000;

// ─────────────────────────────────────────────────────────────────────────────
// OAuth / Authentication
// ─────────────────────────────────────────────────────────────────────────────

export const OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export const HTTP_REDIRECT = 301;
export const SIGN_IN_SUCCESS_URL =
  "https://developers.google.com/gemini-code-assist/auth_success_gemini";
export const SIGN_IN_FAILURE_URL =
  "https://developers.google.com/gemini-code-assist/auth_failure_gemini";

// ─────────────────────────────────────────────────────────────────────────────
// Code Assist API
// ─────────────────────────────────────────────────────────────────────────────

export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";
export const CODE_ASSIST_BASE_URL = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
