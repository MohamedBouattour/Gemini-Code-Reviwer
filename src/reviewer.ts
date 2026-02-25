// Copyright 2026 Google LLC

import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { scanCodeDirectory } from "./scanner.js";
import { extractSkills } from "./skills.js";
import { generateMarkdownReport, CodeReviewResponse } from "./formatter.js";
import ora from "ora";
import * as http from "node:http";
import url from "node:url";
import crypto from "node:crypto";
import open from "open";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Reuse from @google/gemini-cli-core (deep imports to avoid heavy barrel init)
// ---------------------------------------------------------------------------
import { Storage } from "@google/gemini-cli-core/dist/src/config/storage.js";
import { getAvailablePort } from "@google/gemini-cli-core/dist/src/code_assist/oauth2.js";

// ---------------------------------------------------------------------------
// OAuth credentials — read at runtime from the installed @google/gemini-cli-core
// package to avoid duplicating secrets in source (GitHub Push Protection).
// These are public "installed app" credentials per Google's OAuth2 policy:
// https://developers.google.com/identity/protocols/oauth2#installed
// ---------------------------------------------------------------------------

interface OAuthCoreCredentials {
  clientId: string;
  clientSecret: string;
}

let _cachedCoreCredentials: OAuthCoreCredentials | null = null;

/**
 * Extracts the OAuth client ID and secret from
 * @google/gemini-cli-core's compiled oauth2.js at runtime.
 * Caches the result so the file is only read once.
 */
function getCoreOAuthCredentials(): OAuthCoreCredentials {
  if (_cachedCoreCredentials) return _cachedCoreCredentials;

  const require = createRequire(import.meta.url);
  const modulePath =
    require.resolve("@google/gemini-cli-core/dist/src/code_assist/oauth2.js");
  const source = readFileSync(modulePath, "utf-8");

  const idMatch = source.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
  const secretMatch = source.match(
    /OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/,
  );

  if (!idMatch || !secretMatch) {
    throw new Error(
      "Could not extract OAuth credentials from @google/gemini-cli-core. " +
        "The package may have changed its internal structure. " +
        "Please update @google/gemini-cli-core to a compatible version.",
    );
  }

  _cachedCoreCredentials = {
    clientId: idMatch[1],
    clientSecret: secretMatch[1],
  };
  return _cachedCoreCredentials;
}

// Non-secret constants (safe to keep in source)
const OAUTH_SCOPE = ["https://www.googleapis.com/auth/cloud-platform"];
const HTTP_REDIRECT = 301;
const SIGN_IN_SUCCESS_URL =
  "https://developers.google.com/gemini-code-assist/auth_success_gemini";
const SIGN_IN_FAILURE_URL =
  "https://developers.google.com/gemini-code-assist/auth_failure_gemini";

// ---------------------------------------------------------------------------
// Credential caching — reads/writes the SAME file gemini-cli uses:
//   ~/.gemini/oauth_creds.json  (via Storage.getOAuthCredsPath())
// ---------------------------------------------------------------------------

/**
 * Attempt to load cached OAuth credentials saved by gemini-cli.
 * Returns null if the file does not exist or is not readable.
 */
async function loadCachedCredentials(
  logDebug: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  const credsPath: string = Storage.getOAuthCredsPath();
  try {
    const raw = await fs.readFile(credsPath, "utf-8");
    const parsed = JSON.parse(raw);
    logDebug(`Loaded cached OAuth credentials from ${credsPath}`);
    return parsed;
  } catch {
    logDebug(`No cached credentials found at ${credsPath}`);
    return null;
  }
}

/**
 * Save OAuth credentials to the same location gemini-cli uses,
 * so future invocations (of either tool) skip the browser step.
 */
async function saveCachedCredentials(
  credentials: Record<string, unknown>,
  logDebug: (msg: string) => void,
): Promise<void> {
  const credsPath: string = Storage.getOAuthCredsPath();
  const dir = Storage.getGlobalGeminiDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(credsPath, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    logDebug(`Saved OAuth credentials to ${credsPath}`);
  } catch (e: any) {
    logDebug(`Warning: could not persist credentials: ${e.message}`);
  }
}

/**
 * Launch a one-shot browser-based OAuth2 flow (last resort).
 * Mirrors gemini-cli's authWithWeb implementation.
 */
async function browserOAuthFlow(
  logDebug: (msg: string) => void,
): Promise<string> {
  const { clientId, clientSecret } = getCoreOAuthCredentials();
  const client = new OAuth2Client(clientId, clientSecret);

  const port: number = await getAvailablePort();
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

            // Persist tokens so next run (and gemini-cli) can reuse them
            await saveCachedCredentials(
              tokens as unknown as Record<string, unknown>,
              logDebug,
            );

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

// ---------------------------------------------------------------------------
// Authentication: 3-tier strategy
//   1. Cached gemini-cli credentials (~/.gemini/oauth_creds.json)
//   2. ADC (gcloud auth application-default login)
//   3. Browser OAuth flow (last resort)
// ---------------------------------------------------------------------------

interface AuthResult {
  token: string;
  quotaProjectId?: string | null;
}

async function authenticate(
  logDebug: (msg: string) => void,
): Promise<AuthResult> {
  // --- Strategy 1: Reuse cached tokens from gemini-cli ---
  const cached = await loadCachedCredentials(logDebug);
  if (cached) {
    const { clientId, clientSecret } = getCoreOAuthCredentials();
    const client = new OAuth2Client(clientId, clientSecret);
    client.setCredentials(cached as any);
    try {
      const { token } = await client.getAccessToken();
      if (token) {
        logDebug("Successfully reused cached gemini-cli credentials.");
        return { token };
      }
    } catch (e: any) {
      logDebug(`Cached credentials expired or invalid: ${e.message}`);
    }
  }

  // --- Strategy 2: Application Default Credentials (ADC) ---
  const defaultAuth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  try {
    const client = await defaultAuth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    if (accessTokenResponse.token) {
      logDebug("Successfully obtained token from ADC.");
      return {
        token: accessTokenResponse.token,
        quotaProjectId: client.quotaProjectId,
      };
    }
  } catch (e: any) {
    logDebug(`ADC auth failed: ${e.message}`);
  }

  // --- Strategy 3: Browser OAuth flow (last resort) ---
  logDebug("Falling back to browser-based OAuth2 flow...");
  const token = await browserOAuthFlow(logDebug);
  return { token };
}

// ---------------------------------------------------------------------------
// Main review entry point
// ---------------------------------------------------------------------------

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

  // --- Resolve project ID ---
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

  // --- Authenticate ---
  spinner.text = "Authenticating...";
  let authResult: AuthResult;
  try {
    authResult = await authenticate(logDebug);
  } catch (e: any) {
    spinner.fail(`Authentication failed: ${e.message}`);
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

  // --- Prepare Gemini API call ---
  spinner.start("Calling Gemini API (Vertex AI) to review code...");
  logDebug(
    `Initializing GoogleGenAI SDK with project: ${projectId}, location: ${location}`,
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authResult.token}`,
  };

  if (authResult.quotaProjectId) {
    headers["X-Goog-User-Project"] = authResult.quotaProjectId;
    logDebug(`Added X-Goog-User-Project header: ${authResult.quotaProjectId}`);
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
  const allFindings: any[] = [];
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
