#!/usr/bin/env node
// Copyright 2026 Google LLC

import { Command } from "commander";
import dotenv from "dotenv";
import { runReview } from "./reviewer.js";

// Load environment variables from .env
dotenv.config();

const program = new Command();

program
  .name("gemini-code-reviewer")
  .description("AI-powered code reviewer using Google Gemini")
  .version("1.0.0")
  .option("-d, --dir <directory>", "Directory to scan", process.cwd())
  .option(
    "-l, --location <location>",
    "Google Cloud Location for Gemini",
    "us-central1",
  )
  .option("--debug", "Enable debug logging", false)
  .action(async (options) => {
    try {
      console.log(`Starting review in directory: ${options.dir}`);
      await runReview(options.dir, options.location, options.debug);
    } catch (error) {
      console.error("Error during code review:", error);
      process.exit(1);
    }
  });

program.parse(process.argv);
