#!/usr/bin/env node
// Copyright 2026 Google LLC

/**
 * main.ts — Presentation layer entry point (Clean Architecture).
 *
 * ## Responsibilities
 *   1. Parse CLI flags (Commander).
 *   2. Authenticate the user (OAuth).
 *   3. Wire the Dependency Container with all resolved dependencies.
 *   4. Delegate to Use Cases (RunCodeReview, BootstrapProject) via the container.
 *   5. Write final output (stdout + .md files).
 *
 * ## What does NOT live here
 *   - Business logic  → application/use-cases/
 *   - AI API calls    → infrastructure/ai/GeminiProvider.ts
 *   - File scanning   → infrastructure/filesystem/ (via DependencyContainer)
 *   - Scoring/report  → ReportBuilder.ts (via DependencyContainer)
 *
 * ## Dependency Injection wiring
 *   All concrete classes are instantiated ONLY in this file (via DependencyContainer).
 *   Use Cases receive interfaces — they never import concrete infrastructure classes.
 */

import { Command } from "commander";
import dotenv from "dotenv";
import path from "node:path";
import { promises as nodefs } from "node:fs";
import ora from "ora";

// ── Shared utilities ──────────────────────────────────────────────────────────
import { createLogger } from "../../shared/utils/Logger.js";

// ── Infrastructure: Authentication (outer shell / framework) ──────────────────
// Auth lives at the boundary of the Presentation layer.
// It produces credentials that are passed INTO the container — never imported
// by Use Cases.
import {
  authenticate,
  resolveCloudProject,
} from "../../infrastructure/auth/GoogleAuth.js";

// ── Dependency Container (the composition root) ───────────────────────────────
import {
  DependencyContainer,
  type ContainerConfig,
} from "./DependencyContainer.js";

// ── Infrastructure: Persistence ───────────────────────────────────────────────
import { FeedbackStore } from "../../infrastructure/persistence/FeedbackStore.js";

// Load .env at startup
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// CLI program definition
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("gemini-code-reviewer")
  .description(
    "AI-powered code reviewer using Google Gemini — Clean Architecture",
  )
  .version("2.0.0");

// ─────────────────────────────────────────────────────────────────────────────
// Shared auth helper
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCredentials(
  logDebug: (msg: string) => void,
  forceLogin: boolean,
): Promise<{ accessToken: string; cloudProject: string }> {
  const oauthClient = await authenticate(logDebug, forceLogin);
  const { token } = await oauthClient.getAccessToken();
  if (!token) throw new Error("No access token returned after authentication.");
  const cloudProject = await resolveCloudProject(token, logDebug);
  return { accessToken: token, cloudProject };
}

// ─────────────────────────────────────────────────────────────────────────────
// `init` command — Generate / improve .agents/skills/
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description(
    "Auto-discover the project and generate a tailored .agents/skills/ directory",
  )
  .option("-d, --dir <directory>", "Project root directory", process.cwd())
  .option("--debug", "Enable debug logging", false)
  .option("--login", "Force a fresh browser-based login", false)
  .option(
    "--overwrite",
    "Overwrite existing skill files without prompting",
    false,
  )
  .action(async (options) => {
    const logDebug = createLogger(options.debug);
    const spinner = ora();

    console.log("\n🔬 gemini-code-reviewer init — Project Auto-Discovery");
    console.log(`📂 Analysing: ${options.dir}\n`);

    try {
      spinner.start("Authenticating…");
      const { accessToken, cloudProject } = await resolveCredentials(
        logDebug,
        options.login,
      );
      spinner.succeed("Authenticated.");

      // Load false-positive feedback (non-fatal if missing)
      const feedbackStore = new FeedbackStore(options.dir);
      await feedbackStore.load();

      // Build the DI container
      const config: ContainerConfig = {
        accessToken,
        cloudProject,
        logDebug,
        feedbackManager: feedbackStore,
      };
      const container = DependencyContainer.create(config);

      // Execute the use case
      await container.bootstrapProject.execute({
        baseDir: options.dir,
        forceOverwrite: options.overwrite,
        logDebug,
        onProgress: (msg) => {
          spinner.text = msg;
        },
      });

      spinner.stop();
    } catch (e: any) {
      spinner.fail(`Init failed: ${e.message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Default command — run the full code review
// ─────────────────────────────────────────────────────────────────────────────

program
  .option("-d, --dir <directory>", "Directory to scan", process.cwd())
  .option("--debug", "Enable debug logging", false)
  .option("--login", "Force a fresh browser-based login", false)
  .option(
    "--skip-init",
    "Skip auto-discovery phase even when .skills/ is absent",
    false,
  )
  .action(async (options) => {
    const logDebug = createLogger(options.debug);
    const spinner = ora();
    const targetDir: string = options.dir;

    try {
      // ── Step 1: Authenticate ────────────────────────────────────────────────
      spinner.start("Authenticating…");
      const { accessToken, cloudProject } = await resolveCredentials(
        logDebug,
        options.login,
      );
      spinner.succeed("Authenticated.");

      // ── Step 2: Load false-positive feedback ────────────────────────────────
      const feedbackStore = new FeedbackStore(targetDir);
      await feedbackStore.load();
      logDebug(
        `Loaded ${feedbackStore.entries.length} false-positive suppression(s).`,
      );

      // ── Step 3: Wire the Dependency Container (Composition Root) ─────────────
      //
      // This is the ONLY place where concrete infrastructure classes are
      // instantiated. Every Use Case receives INTERFACES, not concretions.
      //
      // ┌────────────────────────────────────────────────────────────┐
      // │  ContainerConfig                                            │
      // │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
      // │  │ accessToken  │  │ cloudProject │  │  feedbackManager │ │
      // │  └──────────────┘  └──────────────┘  └──────────────────┘ │
      // │              ↓              ↓                  ↓            │
      // │         DependencyContainer.create(config)                  │
      // │              ↓                                              │
      // │  ┌───────────────────┐  ┌──────────────────────────────┐  │
      // │  │  runCodeReview    │  │  bootstrapProject            │  │
      // │  │  : RunCodeReview  │  │  : BootstrapProject          │  │
      // │  └───────────────────┘  └──────────────────────────────┘  │
      // └────────────────────────────────────────────────────────────┘
      const config: ContainerConfig = {
        accessToken,
        cloudProject,
        logDebug,
        feedbackManager: feedbackStore,
      };
      const container = DependencyContainer.create(config);

      // ── Step 4: Auto-init (if .agents/skills/ is absent) ────────────────────
      if (!options.skipInit) {
        const skillsDir = path.join(targetDir, ".agents", "skills");
        let skillsPresent = false;
        try {
          const entries = await nodefs.readdir(skillsDir);
          skillsPresent = entries.some((e) => !e.startsWith("."));
        } catch {
          skillsPresent = false;
        }

        if (!skillsPresent) {
          console.log(
            `\n⚡ No .agents/skills/ directory found — launching Auto-Discovery first.\n` +
              `   Run with --skip-init to bypass this step.\n`,
          );

          spinner.start("Running Auto-Discovery (skill generation)…");
          try {
            await container.bootstrapProject.execute({
              baseDir: targetDir,
              forceOverwrite: false,
              logDebug,
              onProgress: (msg) => {
                spinner.text = msg;
              },
            });
            spinner.succeed("Auto-Discovery complete.");
          } catch (e: any) {
            spinner.warn(
              `Auto-Discovery encountered an error (${e.message}) — continuing with review.`,
            );
          }
        }
      }

      // ── Step 5: Run the Code Review ──────────────────────────────────────────
      console.log(`\nStarting review in directory: ${targetDir}`);
      spinner.start("Scanning project…");

      const { report, outputDir } = await container.runCodeReview.execute({
        baseDir: targetDir,
        logDebug,
        onProgress: (msg) => {
          spinner.text = msg;
        },
      });

      spinner.succeed("Review complete.");

      // ── Step 6: Render and write output ──────────────────────────────────────
      // The ReportBuilder renders both chalk (terminal) and plain (file) outputs.
      const { ReportBuilder } = await import("../report/ReportBuilder.js");
      const builder = new ReportBuilder();
      builder.addAiFindings(report.codeFindings);
      builder.addSecretResults(report.secretFindings);
      builder.addInfrastructureResults({
        findings: report.infraFindings,
        isPublicFacing: report.isPublicFacing,
        scannedFiles: report.infraScannedFiles,
      });
      if (report.aiSubScores) builder.setAiScores(report.aiSubScores);
      if (report.executiveSummary)
        builder.setExecutiveSummary(report.executiveSummary);

      const finalScore = builder.calculateFinalScore();
      const consoleOutput = builder.build(true);
      const markdownOutput = builder.build(false);

      // Print to terminal
      console.log("\n" + consoleOutput);
      console.log(`\n📊 Final Score: ${finalScore}/100\n`);

      // Write .md file
      const mdPath = path.join(outputDir, "code-review-report.md");
      await nodefs.writeFile(mdPath, markdownOutput, "utf-8");
      console.log(`📝 Report written to: ${mdPath}`);
    } catch (e: any) {
      spinner.fail(`Review failed: ${e.message}`);
      if (options.debug) console.error(e);
      process.exit(1);
    }
  });

program.parse(process.argv);
