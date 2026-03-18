// Copyright 2026 Google LLC

/**
 * BootstrapProject — the "init" use case.
 *
 * Generates or improves `.agents/skills/` SKILL.md files from a project scan.
 *
 * Moved from discovery.ts (which mixed prompt-building, filesystem I/O, and
 * flow control). The use case coordinating logic now lives here; prompts live
 * in GeminiProvider; filesystem I/O lives in IFileScanner/LocalSkillRepository.
 *
 * Smart-Merge Strategy (unchanged):
 *   MISSING  → Generate from scratch.
 *   EMPTY    → Generate from scratch.
 *   HAS CONTENT → Preserve every existing rule, add new ones.
 */

import * as nodefs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import type {
  IFileScanner,
  ScannedProject,
} from "../core/interfaces/IFileScanner.js";
import type { IAiProvider } from "../core/interfaces/IAiProvider.js";
import type { ISkillRepository } from "../core/interfaces/ISkillRepository.js";
import {
  BUILD_SKILLS_SYSTEM_PROMPT,
  BUILD_FRESH_SKILLS_PROMPT,
} from "../infrastructure/ai/prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SKILL_NAMES = [
  "coding-standards",
  "testing-philosophy",
  "ci-cd-requirements",
  "architecture-patterns",
] as const;

type SkillName = (typeof SKILL_NAMES)[number];

const MAX_EXISTING_CONTENT_CHARS = 6_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SkillStatus = "missing" | "empty" | "has-content";

interface SkillFileInfo {
  skillName: SkillName;
  filePath: string;
  status: SkillStatus;
  existingContent?: string;
}

export interface BootstrapProjectInput {
  baseDir: string;
  /** Pre-loaded scan (from the auto-init flow). */
  preloadedProject?: ScannedProject;
  forceOverwrite?: boolean;
  debug?: boolean;
  logDebug: (msg: string) => void;
  onProgress?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// BootstrapProject
// ─────────────────────────────────────────────────────────────────────────────

export class BootstrapProject {
  constructor(
    private readonly scanner: IFileScanner,
    private readonly aiProvider: IAiProvider,
    private readonly _skillRepository: ISkillRepository,
  ) {}

  async execute(input: BootstrapProjectInput): Promise<void> {
    const {
      baseDir,
      preloadedProject,
      forceOverwrite = false,
      logDebug,
      onProgress = () => {},
    } = input;

    const skillsDir = path.join(baseDir, ".agents", "skills");

    // ── Step 0: Analyze existing skill files ─────────────────────────────────
    onProgress("🔎 Analyzing existing skill files…");
    const skillInfos = await this.analyzeExistingSkills(skillsDir);
    const missingOrEmpty = skillInfos.filter((i) => i.status !== "has-content");
    const hasContent = skillInfos.filter((i) => i.status === "has-content");

    logDebug(
      `Skill status: ${skillInfos.map((i) => `${i.skillName}=${i.status}`).join(", ")}`,
    );

    // Interactive prompts (non-destructive merge)
    if (missingOrEmpty.length === 0 && !forceOverwrite) {
      console.log(`\n✅  All 4 skill files already exist with content.`);
      const improve = await this.askYesNo(
        `\nDo you want to improve them using the current project scan?\n` +
          `   (Existing rules will be KEPT — only new patterns will be ADDED)`,
      );
      if (!improve) {
        console.log(
          "\n⏭️  Skipping skill improvement. All existing skills kept unchanged.\n",
        );
        return;
      }
      console.log("");
    } else if (missingOrEmpty.length === 4 && !forceOverwrite) {
      console.log(
        `\n🆕  No skill files found — generating all 4 from scratch.\n`,
      );
    } else if (!forceOverwrite) {
      const summary = this.formatSkillSummary(skillInfos);
      console.log(
        `\n🔄  Mixed skill state (${summary}) — auto-improving without prompting.\n`,
      );
    }

    // ── Step 1: Get project context ───────────────────────────────────────────
    let project: ScannedProject;
    if (preloadedProject) {
      project = preloadedProject;
      logDebug(
        `Reusing pre-loaded project scan: ${project.codeFiles.length} source file(s).`,
      );
      console.log(
        `ℹ️  Reusing project scan: ${project.codeFiles.length} source file(s), ` +
          `${project.sampleSources.length} source sample(s), ` +
          `${project.sampleTests.length} test sample(s).`,
      );
    } else {
      onProgress("🔍 Scanning project…");
      project = await this.scanner.scan(baseDir);
      onProgress(
        `✅ Project scanned: ${project.codeFiles.length} source files, ` +
          `${project.sampleSources.length} samples, ${project.sampleTests.length} test samples.`,
      );
    }

    // ── Step 2: Build prompt & call AI ───────────────────────────────────────
    const prompt = forceOverwrite
      ? this.buildFreshSkillsPrompt(project)
      : this.buildSkillsPrompt(project, skillInfos);

    logDebug(`Skills prompt length: ${prompt.length} chars`);

    const actionVerb =
      hasContent.length > 0 && !forceOverwrite ? "Improving" : "Generating";
    onProgress(`🤖 ${actionVerb} skills with Gemini Pro…`);

    const skillFiles = await this.aiProvider.generateSkills(prompt);
    onProgress(`✅ Skills ${actionVerb.toLowerCase()}d by Gemini Pro.`);

    // ── Step 3: Write .agents/skills/<name>/SKILL.md ─────────────────────────
    onProgress("💾 Writing .agents/skills/ files…");

    const writeResults: string[] = [];
    let written = 0;
    let skipped = 0;

    for (const skillName of SKILL_NAMES) {
      const content = skillFiles[skillName];
      if (!content?.trim()) {
        logDebug(
          `Gemini returned empty content for skill: ${skillName} — skipping.`,
        );
        skipped++;
        continue;
      }

      const info = skillInfos.find((i) => i.skillName === skillName)!;
      const action =
        info.status === "has-content" && !forceOverwrite
          ? "⬆️  improved"
          : "🆕 generated";

      try {
        const targetPath = path.join(skillsDir, skillName, "SKILL.md");
        await nodefs.mkdir(path.join(skillsDir, skillName), {
          recursive: true,
        });
        await nodefs.writeFile(targetPath, content, "utf-8");
        writeResults.push(`   ${action}  ${skillName}/SKILL.md`);
        written++;
        logDebug(`Wrote .agents/skills/${skillName}/SKILL.md`);
      } catch (e: unknown) {
        logDebug(
          `Failed to write ${skillName}: ${e instanceof Error ? e.message : String(e)}`,
        );
        skipped++;
      }
    }

    if (written === 0) {
      throw new Error("Gemini returned empty content for all skills.");
    }

    const relSkillsDir =
      path.relative(process.cwd(), skillsDir) || ".agents/skills";
    const generated = skillInfos.filter(
      (i) => i.status !== "has-content" || forceOverwrite,
    ).length;
    const improved = skillInfos.filter(
      (i) => i.status === "has-content" && !forceOverwrite,
    ).length;

    const summaryLines: string[] = [];
    if (generated > 0)
      summaryLines.push(`  Generated (new/empty): ${generated} skill(s)`);
    if (improved > 0)
      summaryLines.push(
        `  Improved  (preserved + extended): ${improved} skill(s)`,
      );
    if (skipped > 0)
      summaryLines.push(`  Skipped   (no output): ${skipped} skill(s)`);

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🎉  Skills Update Complete!                                  ║
╠══════════════════════════════════════════════════════════════╣
║  Skill directory: ${relSkillsDir}/
${summaryLines.map((l) => `║  ${l}`).join("\n")}
║
║  • coding-standards/SKILL.md
║  • testing-philosophy/SKILL.md
║  • ci-cd-requirements/SKILL.md
║  • architecture-patterns/SKILL.md
║
║  All skills auto-injected into every code review.            ║
╚══════════════════════════════════════════════════════════════╝
`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Prompt builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildSkillsPrompt(
    project: ScannedProject,
    skillInfos: SkillFileInfo[],
  ): string {
    const sections: string[] = [];

    sections.push(BUILD_SKILLS_SYSTEM_PROMPT);

    sections.push(...this.buildProjectContextSections(project));
    sections.push(this.buildPerSkillInstructions(skillInfos));

    return sections.join("\n\n");
  }

  private buildFreshSkillsPrompt(project: ScannedProject): string {
    const sections: string[] = [];

    sections.push(BUILD_FRESH_SKILLS_PROMPT);

    sections.push(...this.buildProjectContextSections(project));

    return sections.join("\n\n");
  }

  private buildProjectContextSections(project: ScannedProject): string[] {
    const sections: string[] = [];

    if (project.packageJson) {
      sections.push(
        `## package.json\n\`\`\`json\n${project.packageJson}\n\`\`\``,
      );
    }
    sections.push(
      `## Directory Structure (depth 3)\n\`\`\`\n${project.directoryTree}\n\`\`\``,
    );

    if (project.codeFiles.length > 0) {
      const manifest = project.codeFiles
        .map((f) => `  ${f.filePath}`)
        .join("\n");
      sections.push(
        `## Complete Source File List (${project.codeFiles.length} files)\n\`\`\`\n${manifest}\n\`\`\``,
      );
    }

    if (Object.keys(project.configFiles).length > 0) {
      const cf = Object.entries(project.configFiles)
        .map(([k, v]) => `### ${k}\n\`\`\`\n${v}\n\`\`\``)
        .join("\n\n");
      sections.push(`## Configuration Files\n${cf}`);
    }

    if (Object.keys(project.ciFiles).length > 0) {
      const ci = Object.entries(project.ciFiles)
        .map(([n, v]) => `### ${n}\n\`\`\`yaml\n${v}\n\`\`\``)
        .join("\n\n");
      sections.push(`## CI/CD Pipelines\n${ci}`);
    }

    if (project.sampleSources.length > 0) {
      const sources = project.sampleSources
        .map((s) => `### ${s.relPath}\n\`\`\`\n${s.content}\n\`\`\``)
        .join("\n\n");
      sections.push(
        `## Representative Business-Logic Files (${project.sampleSources.length})\n${sources}`,
      );
    }

    if (project.sampleTests.length > 0) {
      const tests = project.sampleTests
        .map((t) => `### ${t.relPath}\n\`\`\`\n${t.content}\n\`\`\``)
        .join("\n\n");
      sections.push(
        `## Representative Test Files (${project.sampleTests.length})\n${tests}`,
      );
    }

    return sections;
  }

  private buildPerSkillInstructions(skillInfos: SkillFileInfo[]): string {
    const lines: string[] = [
      "## Per-Skill Instructions",
      "",
      "For each skill key in your JSON response, follow the instruction below exactly.",
      "",
    ];

    for (const info of skillInfos) {
      if (info.status === "has-content") {
        const cap = info.existingContent!.slice(0, MAX_EXISTING_CONTENT_CHARS);
        const truncated =
          info.existingContent!.length > MAX_EXISTING_CONTENT_CHARS
            ? "\n…[truncated for brevity]"
            : "";
        lines.push(
          `### ${info.skillName}  →  ⬆️  IMPROVE (merge existing + project scan)`,
          "",
          "**STRICT MERGE RULES:**",
          "1. Copy EVERY existing rule, pattern, and convention into the output verbatim — do NOT omit, reword, or weaken any.",
          "2. Identify gaps: what patterns does the project scan reveal that the existing skill does NOT yet cover?",
          "3. Append NEW sections/rules for those gaps only.",
          "4. Do NOT duplicate rules that already exist.",
          "5. The YAML frontmatter may be updated (better description) but the `name` key must stay unchanged.",
          "",
          "**Existing content to preserve and extend:**",
          "```markdown",
          cap + truncated,
          "```",
          "",
        );
      } else {
        const reason =
          info.status === "empty" ? "⬜ EMPTY file" : "🆕 MISSING file";
        lines.push(
          `### ${info.skillName}  →  ${reason} — GENERATE from scratch`,
          "",
          "Generate a comprehensive, project-specific SKILL.md based on everything observed in the project scan above.",
          "Be specific: reference actual file names, detected libraries, test runner, CI steps, and folder patterns.",
          "",
        );
      }
    }

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Skill file analysis
  // ─────────────────────────────────────────────────────────────────────────

  private async analyzeExistingSkills(
    skillsDir: string,
  ): Promise<SkillFileInfo[]> {
    const results: SkillFileInfo[] = [];

    for (const skillName of SKILL_NAMES) {
      const filePath = path.join(skillsDir, skillName, "SKILL.md");
      let status: SkillStatus;
      let existingContent: string | undefined;

      try {
        const raw = await nodefs.readFile(filePath, "utf-8");
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          status = "empty";
        } else {
          status = "has-content";
          existingContent = trimmed;
        }
      } catch {
        status = "missing";
      }

      results.push({ skillName, filePath, status, existingContent });
    }

    return results;
  }

  private formatSkillSummary(infos: SkillFileInfo[]): string {
    const missing = infos.filter((i) => i.status === "missing").length;
    const empty = infos.filter((i) => i.status === "empty").length;
    const hasContent = infos.filter((i) => i.status === "has-content").length;

    const parts: string[] = [];
    if (missing + empty > 0) parts.push(`${missing + empty} to generate`);
    if (hasContent > 0) parts.push(`${hasContent} to improve`);
    return parts.join(", ") || "nothing to do";
  }

  private async askYesNo(question: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  }
}
