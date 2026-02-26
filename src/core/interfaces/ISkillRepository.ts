// Copyright 2026 Google LLC

/**
 * ISkillRepository — port for reading project-specific skill/context files.
 *
 * Lives in the Core layer. Zero filesystem imports.
 * Implementation (LocalSkillRepository) lives in infrastructure/config/.
 */
export interface ISkillRepository {
  /**
   * Load all skill Markdown files from the well-known skill directories
   * (.agents/skills/, .gemini/, _agents/, etc.) under `baseDir`.
   *
   * @param baseDir  Absolute path to the project root.
   * @returns        A concatenated skills prompt string, or a fallback
   *                 default if no skill files are found.
   */
  loadSkillsContext(baseDir: string): Promise<string>;
}
