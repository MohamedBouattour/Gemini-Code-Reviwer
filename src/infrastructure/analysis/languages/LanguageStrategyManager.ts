// Copyright 2026 Google LLC

import * as path from "node:path";
import type { ILanguageStrategy } from "./ILanguageStrategy.js";
import { TypeScriptStrategy } from "./TypeScriptStrategy.js";
import { JavaStrategy } from "./JavaStrategy.js";
import { PythonStrategy } from "./PythonStrategy.js";
import { GoStrategy } from "./GoStrategy.js";
import { CSharpStrategy } from "./CSharpStrategy.js";
import { GenericStrategy } from "./GenericStrategy.js";

/**
 * LanguageStrategyManager — selects the appropriate analysis strategy
 * based on file extension.
 */
export class LanguageStrategyManager {
  private static strategies: ILanguageStrategy[] = [
    new TypeScriptStrategy(),
    new JavaStrategy(),
    new PythonStrategy(),
    new GoStrategy(),
    new CSharpStrategy(),
  ];

  private static fallback = new GenericStrategy();

  /**
   * Returns a strategy for the given file.
   * Falls back to GenericStrategy if no specific strategy matches.
   */
  static getStrategy(filePath: string): ILanguageStrategy {
    const ext = path.extname(filePath).toLowerCase();
    return (
      this.strategies.find((s) => s.extensions.includes(ext)) ?? this.fallback
    );
  }
}
