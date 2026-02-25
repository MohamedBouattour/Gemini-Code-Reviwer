// Copyright 2026 Google LLC

import { GoogleAuth } from "google-auth-library";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { scanCodeDirectory } from "./scanner.js";
import { extractSkills } from "./skills.js";
import { generateMarkdownReport, CodeReviewResponse } from "./formatter.js";
import ora from "ora";

export async function runReview(
  baseDir: string,
  location: string = "us-central1",
): Promise<void> {
  const spinner = ora("Setting up Google Cloud Auth...").start();

  let projectId = process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    spinner.text =
      "Fetching project ID from Application Default Credentials...";
    try {
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      projectId = await auth.getProjectId();
    } catch (e) {
      spinner.fail("Failed to load Google Cloud Auth credentials.");
      console.error(e);
      process.exit(1);
    }
  }

  if (!projectId) {
    spinner.fail(
      "GOOGLE_CLOUD_PROJECT was not set and could not be detected via ADC.",
    );
    process.exit(1);
  }

  spinner.succeed(`Authenticated with project: ${projectId}`);
  spinner.start("Scanning repository for code files...");

  const files = await scanCodeDirectory(baseDir);

  if (files.length === 0) {
    spinner.info("No valid source files found for review.");
    process.exit(0);
  }

  spinner.succeed(`Found ${files.length} source files to review.`);
  spinner.start("Loading skills context (Markdowns)...");

  const skillsContext = await extractSkills(baseDir);

  spinner.succeed("Skills injected.");

  // Create formatted prompt
  spinner.start("Calling Gemini API (Vertex AI) to review code...");

  const ai = new GoogleGenAI({
    vertexai: {
      project: projectId,
      location: location,
    },
  });

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      overallScore: {
        type: Type.NUMBER,
        description: "The overall logic and architectural score from 0 to 100.",
      },
      findings: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            file: { type: Type.STRING, description: "The exact file path" },
            line: {
              type: Type.STRING,
              description: "Line numbers (e.g. 5 or 12-15)",
            },
            code: {
              type: Type.STRING,
              description: "The specific snippet being flagged",
            },
            feedback: {
              type: Type.STRING,
              description:
                "Idea, bug, or refactoring suggestion based on skills",
            },
          },
          required: ["file", "line", "code", "feedback"],
        },
      },
    },
    required: ["overallScore", "findings"],
  };

  let payload = "Review the following code:\n\n";
  for (const f of files) {
    payload += `--- FILE BEGIN: ${f.filePath} ---\n${f.content}\n--- FILE END ---\n\n`;
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-1.5-pro",
      contents: payload,
      config: {
        systemInstruction: `You are an expert Google Code Reviewer.\n\n${skillsContext}`,
        responseMIMEType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.2,
      },
    });

    spinner.succeed("Review complete!");

    const responseText = response.text || "{}";
    const reportData: CodeReviewResponse = JSON.parse(responseText);

    const markdownOutput = generateMarkdownReport(reportData);
    console.log("\n\n" + markdownOutput);
  } catch (err: any) {
    spinner.fail("Gemini API call failed.");
    console.error(err?.message || err);
    process.exit(1);
  }
}
