// Copyright 2026 Google LLC

import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";

export interface CodeFile {
  filePath: string;
  content: string;
}

export async function scanCodeDirectory(baseDir: string): Promise<CodeFile[]> {
  // We're specifically targeting the src/ directories (or equivalent layout)
  const pattern = "src/**/*.{java,ts,js,tsx,jsx,html,css,scss}";

  const files = await fg([pattern], {
    cwd: baseDir,
    ignore: [
      "**/*.spec.*",
      "**/*.test.*",
      "**/__tests__/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
    ],
    absolute: true,
  });

  const codeFiles: CodeFile[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf-8");
      codeFiles.push({ filePath: file, content });
    } catch (e) {
      console.warn(`Could not read file ${file}:`, e);
    }
  }

  return codeFiles;
}
