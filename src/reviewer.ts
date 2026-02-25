// Copyright 2026 Google LLC

import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { scanCodeDirectory } from "./scanner.js";
import { extractSkills } from "./skills.js";
import { generateMarkdownReport, CodeReviewResponse } from "./formatter.js";
import ora from "ora";
import open from "open";
import * as http from "node:http";
import url from "node:url";
import crypto from "node:crypto";
import net from "node:net";

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = 0;
    try {
      const portStr = process.env["OAUTH_CALLBACK_PORT"];
      if (portStr) {
        port = parseInt(portStr, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
          return reject(
            new Error(`Invalid value for OAUTH_CALLBACK_PORT: "${portStr}"`),
          );
        }
        return resolve(port);
      }
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          port = address.port;
        }
      });
      server.on("listening", () => {
        server.close();
        server.unref();
      });
      server.on("error", (e) => reject(e));
      server.on("close", () => resolve(port));
    } catch (e) {
      reject(e);
    }
  });
}

async function getBrowserToken(
  logDebug: (msg: string) => void,
): Promise<string> {
  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return Promise.reject(
      new Error(
        "OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET is missing from the environment.",
      ),
    );
  }

  const OAUTH_SCOPE = ["https://www.googleapis.com/auth/cloud-platform"];
  const HTTP_REDIRECT = 301;
  const SIGN_IN_SUCCESS_URL =
    "https://developers.google.com/gemini-code-assist/auth_success_gemini";
  const SIGN_IN_FAILURE_URL =
    "https://developers.google.com/gemini-code-assist/auth_failure_gemini";

  logDebug("Starting browser-based OAuth2 authentication...");
  const client = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);

  const port = await getAvailablePort();
  const host = process.env["OAUTH_CALLBACK_HOST"] || "127.0.0.1";

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = crypto.randomBytes(32).toString("hex");

  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: "offline",
    scope: OAUTH_SCOPE,
    state,
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url!.indexOf("/oauth2callback") === -1) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();
          reject(
            new Error(
              "OAuth callback not received. Unexpected request: " + req.url,
            ),
          );
          return;
        }
        // acquire the code from the querystring, and close the web server.
        const qs = new url.URL(req.url!, "http://127.0.0.1:3000").searchParams;
        if (qs.get("error")) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();

          const errorCode = qs.get("error");
          const errorDescription =
            qs.get("error_description") || "No additional details provided";
          reject(
            new Error(`Google OAuth error: ${errorCode}. ${errorDescription}`),
          );
        } else if (qs.get("state") !== state) {
          res.end("State mismatch. Possible CSRF attack");

          reject(
            new Error(
              "OAuth state mismatch. Possible CSRF attack or browser session issue.",
            ),
          );
        } else if (qs.get("code")) {
          try {
            const { tokens } = await client.getToken({
              code: qs.get("code")!,
              redirect_uri: redirectUri,
            });
            client.setCredentials(tokens);

            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL });
            res.end();
            resolve(tokens.access_token!);
          } catch (error: any) {
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
            res.end();
            reject(
              new Error(
                `Failed to exchange authorization code for tokens: ${error.message || error}`,
              ),
            );
          }
        } else {
          reject(
            new Error(
              "No authorization code received from Google OAuth. Please try authenticating again.",
            ),
          );
        }
      } catch (e: any) {
        reject(
          new Error(
            `Unexpected error during OAuth authentication: ${e.message || e}`,
          ),
        );
      } finally {
        server.close();
      }
    });

    server.listen(port, host, async () => {
      logDebug(`Opening browser at: ${authUrl}`);
      try {
        await open(authUrl);
      } catch (e) {
        logDebug(`Failed to open browser automatically: ${e}`);
        console.log(
          `\n\nPlease open the following URL in your browser:\n${authUrl}\n`,
        );
      }
    });

    server.on("error", (err) => {
      reject(new Error(`OAuth callback server error: ${err.message}`));
    });
  });
}

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

  let projectId: string | undefined;
  const defaultAuth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  try {
    projectId = await defaultAuth.getProjectId();
    logDebug(`Inferred project ID from ADC/gcloud config: ${projectId}`);
  } catch (e: any) {
    logDebug(`Could not infer project ID from ADC/gcloud: ${e.message}`);
  }

  if (!projectId) {
    projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (projectId) {
      logDebug(
        `Found project ID from environment fallback (.env): ${projectId}`,
      );
    } else {
      spinner.fail(
        "GOOGLE_CLOUD_PROJECT was not detected from ADC, gcloud config, or .env.",
      );
      process.exit(1);
    }
  }

  let tokenData: string | null | undefined = null;
  let quotaProjectId: string | null | undefined = null;

  try {
    spinner.text = "Waiting for browser authentication...";
    tokenData = await getBrowserToken(logDebug);
    logDebug("Successfully obtained token from browser.");
  } catch (e) {
    spinner.text = "Browser auth failed or skipped, trying ADC...";
    logDebug(`Browser auth issue: ${e}. Falling back to ADC...`);
    try {
      const client = await defaultAuth.getClient();
      const accessTokenResponse = await client.getAccessToken();
      tokenData = accessTokenResponse.token;
      quotaProjectId = client.quotaProjectId;
      logDebug("Successfully obtained token from ADC fallback.");
    } catch (fallbackError) {
      spinner.fail("Failed to fetch access token from both browser and ADC.");
      console.error(fallbackError);
      process.exit(1);
    }
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
