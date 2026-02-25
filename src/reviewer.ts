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
  debug: boolean = false,
): Promise<void> {
  const spinner = ora("Setting up Google Cloud Auth...").start();
  const logDebug = (msg: string) => {
    if (debug) {
      console.log(`\n[DEBUG] ${msg}`);
    }
  };

  logDebug("Starting authentication process...");

  let projectId = process.env.GOOGLE_CLOUD_PROJECT;

  if (projectId) {
    logDebug(`Found project ID from environment: ${projectId}`);
  }

  logDebug("Initializing GoogleAuth client...");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  if (!projectId) {
    spinner.text =
      "Fetching project ID from Application Default Credentials...";
    logDebug(
      "GOOGLE_CLOUD_PROJECT not found in env, attempting to infer from ADC...",
    );
    try {
      projectId = await auth.getProjectId();
      logDebug(`Inferred project ID from ADC: ${projectId}`);
    } catch (e) {
      spinner.fail("Failed to load Google Cloud Auth credentials.");
      logDebug(`Failed to get project ID: ${e}`);
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

  let tokenData: string | null | undefined = null;
  let quotaProjectId: string | null | undefined = null;

  try {
    logDebug("Fetching access token via GoogleAuth client...");
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    tokenData = accessTokenResponse.token;
    quotaProjectId = client.quotaProjectId;

    logDebug(
      `Successfully obtained token. Quota Project ID: ${quotaProjectId || "None"}`,
    );
  } catch (e) {
    spinner.fail("Failed to fetch access token.");
    logDebug(`Error fetching access token: ${e}`);
    console.error(e);
    process.exit(1);
  }

  spinner.succeed(`Authenticated with project: ${projectId}`);
  spinner.start("Scanning repository for code files...");

  logDebug(`Scanning repository in base directory: ${baseDir}`);
  const files = await scanCodeDirectory(baseDir);

  if (files.length === 0) {
    spinner.info("No valid source files found for review.");
    logDebug("No files found, exiting.");
    process.exit(0);
  }

  spinner.succeed(`Found ${files.length} source files to review.`);
  spinner.start("Loading skills context (Markdowns)...");

  logDebug(`Found ${files.length} files. Extracting skills context...`);
  const skillsContext = await extractSkills(baseDir);

  spinner.succeed("Skills injected.");
  logDebug(
    `Skills injected. Context length: ${skillsContext.length} characters.`,
  );

  // Create formatted prompt
  spinner.start("Calling Gemini API (Vertex AI) to review code...");
  logDebug(
    `Initializing GoogleGenAI SDK with project: ${projectId}, location: ${location}`,
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokenData}`,
  };

  if (quotaProjectId) {
    // This header is crucial for enterprise mail auth / user ADC credentials
    // when accessing GCP APIs like Vertex AI.
    headers["X-Goog-User-Project"] = quotaProjectId;
    logDebug(`Added X-Goog-User-Project header: ${quotaProjectId}`);
  }

  const ai = new GoogleGenAI({
    project: projectId,
    location: location,
    vertexai: true,
    httpOptions: {
      headers,
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
    logDebug(
      `Calling generateContent on model: gemini-1.5-pro... payload length: ${payload.length}`,
    );
    const response = await ai.models.generateContent({
      model: "gemini-1.5-pro",
      contents: payload,
      config: {
        systemInstruction: `You are an expert Google Code Reviewer.\n\n${skillsContext}`,
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.2,
      },
    });

    logDebug("Successfully received response from Gemini API.");
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
