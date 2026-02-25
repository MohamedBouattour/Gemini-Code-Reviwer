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

  const CHAR_THRESHOLD = 30000;

  function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      score: {
        type: Type.NUMBER,
        description:
          "The logic and architectural score from 0 to 100 for this batch.",
      },
      findings: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            file: { type: Type.STRING, description: "The exact file path" },
            line: {
              type: Type.NUMBER,
              description: "Line number",
            },
            snippet: {
              type: Type.STRING,
              description: "The specific snippet being flagged",
            },
            suggestion: {
              type: Type.STRING,
              description:
                "Idea, bug, or refactoring suggestion based on skills",
            },
            priority: {
              type: Type.STRING,
              description: "Priority of the finding",
              enum: ["low", "medium", "high"],
            },
          },
          required: ["file", "line", "snippet", "suggestion", "priority"],
        },
      },
    },
    required: ["score", "findings"],
  };

  spinner.start("Chunking files into batch segments...");

  const segments: string[] = [];
  let currentSegment = "Review the following code:\n\n";

  for (const f of files) {
    const fileXml = `<file path="${f.filePath}">\n${f.content}\n</file>\n\n`;
    if (
      currentSegment.length + fileXml.length > CHAR_THRESHOLD &&
      currentSegment !== "Review the following code:\n\n"
    ) {
      segments.push(currentSegment);
      currentSegment = "Review the following code:\n\n" + fileXml;
    } else {
      currentSegment += fileXml;
    }
  }

  if (currentSegment !== "Review the following code:\n\n") {
    segments.push(currentSegment);
  }

  logDebug(
    `Created ${segments.length} segments based on a ~${CHAR_THRESHOLD} character limit.`,
  );
  spinner.succeed(`Created ${segments.length} segments for review.`);
  spinner.start("Calling Gemini API (Vertex AI) to review code segments...");

  let totalScore = 0;
  let allFindings: any[] = [];
  let batchesSucceeded = 0;

  for (let i = 0; i < segments.length; i++) {
    try {
      const segmentPayload = segments[i];
      const estimatedTokens = estimateTokenCount(segmentPayload);
      logDebug(
        `Sending segment ${i + 1}/${segments.length}, tokens estimated: ${estimatedTokens}`,
      );
      const response = await ai.models.generateContent({
        model: "gemini-1.5-pro",
        contents: segmentPayload,
        config: {
          systemInstruction: skillsContext,
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          temperature: 0.2,
        },
      });

      logDebug(`Successfully received response for segment ${i + 1}.`);
      const responseText = response.text || "{}";
      const reportData = JSON.parse(responseText);

      if (typeof reportData.score === "number") {
        totalScore += reportData.score;
        batchesSucceeded++;
      }

      if (reportData.findings && Array.isArray(reportData.findings)) {
        allFindings.push(...reportData.findings);
      }
    } catch (err: any) {
      logDebug(`Error processing segment ${i + 1}: ${err?.message || err}`);
    }
  }

  if (batchesSucceeded === 0 && segments.length > 0) {
    spinner.fail("Gemini API call failed for all batches.");
    process.exit(1);
  }

  spinner.succeed("Review complete!");

  const finalScore =
    batchesSucceeded > 0 ? Math.round(totalScore / batchesSucceeded) : 0;
  const finalReport: CodeReviewResponse = {
    score: finalScore,
    findings: allFindings,
  };

  const markdownOutput = generateMarkdownReport(finalReport);
  console.log("\n\n" + markdownOutput);
}
