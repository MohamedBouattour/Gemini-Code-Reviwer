// Copyright 2026 Google LLC

/**
 * LocalSkillRepository — implements ISkillRepository.
 *
 * Reads .agents/skills/, .gemini/, and other well-known skill directories
 * from the project root using fast-glob and node:fs.
 */

import fg from "fast-glob";
import fs from "fs/promises";
import type { ISkillRepository } from "../../core/interfaces/ISkillRepository.js";

const SKILL_GLOB_PATTERNS = [
  ".skills/**/*.md",
  ".agents/**/*.md",
  ".agent/**/*.md",
  "_agents/**/*.md",
  "_agent/**/*.md",
  ".gemini/**/*.md",
];

const DEFAULT_PREFIX =
  "You are an elite code reviewer. Your goal is to evaluate the following code strictly against these organizational standards.";

export class LocalSkillRepository implements ISkillRepository {
  async loadSkillsContext(baseDir: string): Promise<string> {
    const files = await fg(SKILL_GLOB_PATTERNS, {
      cwd: baseDir,
      absolute: true,
      ignore: ["node_modules/**", "dist/**", "build/**", ".git/**"],
    });

    let allSkills = "";

    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        allSkills += `\n\n--- Skill Data from ${file} ---\n${content}\n`;
      } catch {
        // Non-fatal: skip unreadable skill files
      }
    }

    return allSkills.trim()
      ? `${DEFAULT_PREFIX}\n${allSkills}`
      : `${DEFAULT_PREFIX}\nNo internal skills provided. Rely on standard industry best practices for all languages present.`;
  }
}
