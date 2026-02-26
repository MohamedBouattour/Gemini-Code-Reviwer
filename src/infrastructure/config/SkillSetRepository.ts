// Copyright 2026 Google LLC

/**
 * SkillSetRepository — implements ISkillRepository.
 *
 * Migration target: src/skills.ts → src/infrastructure/config/SkillSetRepository.ts
 *
 * This is the canonical Clean Architecture location for this class.
 * The full implementation lives in LocalSkillRepository.ts (same directory).
 * This module re-exports it under the architecturally-correct name
 * "SkillSetRepository" that matches the migration plan target name.
 *
 * @see LocalSkillRepository.ts — the full implementation
 */

export { LocalSkillRepository as SkillSetRepository } from "./LocalSkillRepository.js";
