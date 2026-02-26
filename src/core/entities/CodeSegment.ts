// Copyright 2026 Google LLC

/**
 * CodeSegment — represents a contiguous chunk of source code sent to the AI.
 *
 * The scanner populates originalContent (for line-number matching) and
 * content (minified for token efficiency). IFileScanner is responsible for
 * producing these from the filesystem.
 */
export interface CodeSegment {
  /** Relative path to the source file. */
  filePath: string;
  /** Original (un-minified) source content. Used for line-number resolution. */
  originalContent: string;
  /**
   * Minified / optimised content for the AI prompt.
   * Strips comments, imports, and collapses whitespace to reduce token cost.
   */
  content: string;
}
