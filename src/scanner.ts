// Copyright 2026 Google LLC

import fg from "fast-glob";
import fs from "fs/promises";
import * as path from "path";

export interface CodeFile {
  filePath: string;
  originalContent: string;
  content: string;
}

export function optimizeContent(content: string): string {
  let optimized = content.replace(/\r\n/g, "\n");

  // 1. Strip inner paths from SVG elements
  optimized = optimized.replace(
    /(<svg\b[^>]*>)(.*?)(<\/svg>)/gs,
    (_match, p1, p2, p3) => p1 + p3,
  );

  // 2. Remove multi-line comments /* ... */
  optimized = optimized.replace(/\/\*[\s\S]*?\*\//g, "");

  // 3. Remove single-line comments // ...
  optimized = optimized.replace(/(?<!https?:)\/\/.*$/gm, "");

  // 4. Remove imports to save context space
  // JS/TS: Match all variations of `import ... from '...'`
  optimized = optimized.replace(
    /^\s*import\s+[^;]*?from\s+['"].*?['"]\s*;/gm,
    "",
  );
  // JS/TS: Match basic imports like `import '...'`
  optimized = optimized.replace(/^\s*import\s+['"].*?['"]\s*;/gm, "");
  // Java: Match `import java.util.List;` or `import static org.junit.Assert.*;`
  optimized = optimized.replace(/^\s*import\s+(?:static\s+)?[\w.*]+\s*;/gm, "");

  // 5. Squash all newlines and multiple spaces into a single space to save max tokens
  optimized = optimized.replace(/\s+/g, " ").trim();

  return optimized;
}

export async function scanCodeDirectory(baseDir: string): Promise<CodeFile[]> {
  const pattern = "src/**/*.{java,ts,js,tsx,jsx,html,css,scss}";

  let gitIgnores: string[] = [];
  try {
    const gitignoreContent = await fs.readFile(
      path.join(baseDir, ".gitignore"),
      "utf-8",
    );
    gitIgnores = gitignoreContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        let pattern = line.startsWith("/") ? line.substring(1) : "**/" + line;
        if (pattern.endsWith("/")) pattern += "**";
        return pattern;
      });
  } catch (e) {}

  const ignoreList = [
    "**/*.spec.*",
    "**/*.test.*",
    "**/__tests__/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    ".git/**",
    ...gitIgnores,
  ];

  const files = await fg([pattern], {
    cwd: baseDir,
    ignore: ignoreList,
    absolute: true,
  });

  const codeFiles: CodeFile[] = [];

  for (const file of files) {
    try {
      const rawContent = await fs.readFile(file, "utf-8");
      const optContent = optimizeContent(rawContent);
      const relativePath = path.relative(baseDir, file);
      codeFiles.push({
        filePath: relativePath,
        originalContent: rawContent,
        content: optContent,
      });
    } catch (e) {
      console.warn(`Could not read file ${file}:`, e);
    }
  }

  return codeFiles;
}

export function findLineNumberToMatchSnippet(
  originalContent: string,
  snippet: string,
): number {
  if (!snippet || typeof snippet !== "string") return 1;
  const lines = originalContent.split("\n");
  const normSnippet = snippet.replace(/\s+/g, "");
  if (!normSnippet) return 1;

  let normContent = "";
  const indexToLine: number[] = [];
  for (let j = 0; j < lines.length; j++) {
    const strippedLine = lines[j].replace(/\s+/g, "");
    normContent += strippedLine;
    for (let k = 0; k < strippedLine.length; k++) {
      indexToLine.push(j + 1);
    }
  }

  const matchIndex = normContent.indexOf(normSnippet);
  if (matchIndex !== -1) {
    return indexToLine[matchIndex];
  }
  return 1;
}
