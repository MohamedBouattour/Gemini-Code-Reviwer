// Copyright 2026 Google LLC

import fg from "fast-glob";
import fs from "fs/promises";

export async function extractSkills(baseDir: string): Promise<string> {
  const patterns = ["*.md", ".skills/**/*.md"];

  const files = await fg(patterns, {
    cwd: baseDir,
    absolute: true,
    ignore: ["node_modules/**", "dist/**", "build/**", ".git/**"],
  });

  let allSkills = "";

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf-8");
      allSkills += `\n\n--- Skill Data from ${file} ---\n${content}\n`;
    } catch (e) {
      console.warn(`Could not read skill file ${file}:`, e);
    }
  }

  return allSkills.trim()
    ? `Follow these organizational best practices and skills:\n${allSkills}`
    : "No internal skills provided. Rely on standard industry best practices for all languages present.";
}
