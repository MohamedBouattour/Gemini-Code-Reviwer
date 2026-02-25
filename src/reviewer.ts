// Copyright 2026 Google LLC

import { OAuth2Client } from "google-auth-library";
import {
  scanCodeDirectory,
  CodeFile,
  findLineNumberToMatchSnippet,
} from "./scanner.js";
import { extractSkills } from "./skills.js";
import { generateMarkdownReport, CodeReviewResponse } from "./formatter.js";
import ora from "ora";
import * as http from "node:http";
import url from "node:url";
import crypto from "node:crypto";
import open from "open";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  GeminiModel,
  OAUTH_SCOPE,
  HTTP_REDIRECT,
  SIGN_IN_SUCCESS_URL,
  SIGN_IN_FAILURE_URL,
  CODE_ASSIST_BASE_URL,
  CHAR_THRESHOLD,
} from "./constants.js";

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

// ---------------------------------------------------------------------------
// Credential caching — reads/writes the SAME file gemini-cli uses:
//   ~/.gemini/oauth_creds.json  (via Storage.getOAuthCredsPath())
// ---------------------------------------------------------------------------

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
 * Launch a browser-based OAuth2 flow using the same credentials as gemini-cli.
 * Returns an authenticated OAuth2Client with tokens set and persisted.
 */
async function browserOAuthFlow(
  logDebug: (msg: string) => void,
): Promise<OAuth2Client> {
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
          reject(
            new Error(
              `Google OAuth error: ${qs.get("error")}. ${qs.get("error_description") || "No details"}`,
            ),
          );
        } else if (qs.get("state") !== state) {
          res.end("State mismatch. Possible CSRF attack");
          reject(new Error("OAuth state mismatch. Possible CSRF attack."));
        } else if (qs.get("code")) {
          try {
            const { tokens } = await client.getToken({
              code: qs.get("code")!,
              redirect_uri: redirectUri,
            });
            client.setCredentials(tokens);
            await saveCachedCredentials(
              tokens as unknown as Record<string, unknown>,
              logDebug,
            );
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL });
            res.end();
            resolve(client);
          } catch (error: any) {
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
            res.end();
            reject(
              new Error(
                `Failed to exchange authorization code: ${error.message}`,
              ),
            );
          }
        } else {
          reject(
            new Error("No authorization code received from Google OAuth."),
          );
        }
      } catch (e: any) {
        reject(new Error(`Unexpected error during OAuth: ${e.message}`));
      } finally {
        server.close();
      }
    });

    server.listen(port, host, async () => {
      logDebug(`Launching browser OAuth: ${authUrl}`);
      console.log(`\nOpening browser for Google authentication...\n`);
      try {
        await open(authUrl);
      } catch (e) {
        console.log(
          `\nCould not open browser automatically. Please visit:\n\n${authUrl}\n`,
        );
      }
    });

    server.on("error", (err) => {
      reject(new Error(`OAuth callback server error: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Authentication: cached credentials → browser OAuth fallback
// ---------------------------------------------------------------------------

async function clearCachedCredentials(
  logDebug: (msg: string) => void,
): Promise<void> {
  const credsPath: string = Storage.getOAuthCredsPath();
  try {
    await fs.rm(credsPath, { force: true });
    logDebug(`Cleared cached credentials at ${credsPath}`);
  } catch (e: any) {
    logDebug(`Warning: could not clear credentials: ${e.message}`);
  }
}

async function authenticate(
  logDebug: (msg: string) => void,
  forceLogin: boolean = false,
): Promise<OAuth2Client> {
  const { clientId, clientSecret } = getCoreOAuthCredentials();

  // Strategy 1: Reuse cached tokens, unless --login forces fresh auth
  if (!forceLogin) {
    const cached = await loadCachedCredentials(logDebug);
    if (cached) {
      const client = new OAuth2Client(clientId, clientSecret);
      client.setCredentials(cached as any);
      try {
        const { token } = await client.getAccessToken();
        if (token) {
          logDebug("Reused cached credentials successfully.");
          return client;
        }
      } catch (e: any) {
        logDebug(`Cached credentials invalid/expired: ${e.message}`);
      }
    }
  } else {
    logDebug("--login flag set, clearing any cached credentials.");
    await clearCachedCredentials(logDebug);
  }

  // Strategy 2: Browser OAuth (enterprise Google account)
  logDebug("Launching browser OAuth flow...");
  return browserOAuthFlow(logDebug);
}

// ---------------------------------------------------------------------------
// Helper: make authenticated Code Assist API POST calls
// ---------------------------------------------------------------------------

async function codeAssistPost(
  method: string,
  body: unknown,
  token: string,
  logDebug: (msg: string) => void,
): Promise<any> {
  const endpoint = `${CODE_ASSIST_BASE_URL}:${method}`;
  logDebug(`POST ${endpoint}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} on ${method}: ${errText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main review entry point
// ---------------------------------------------------------------------------

export async function runReview(
  baseDir: string,
  _location: string = "us-central1",
  debug: boolean = false,
  forceLogin: boolean = false,
): Promise<void> {
  const spinner = ora("Setting up Google Cloud Auth...").start();
  const logDebug = (msg: string) => {
    if (debug) console.log(`\n[DEBUG] ${msg}`);
  };

  // --- Authenticate ---
  spinner.text = "Authenticating with Google...";
  if (forceLogin) {
    spinner.text = "Launching browser login...";
  }
  let oauthClient: OAuth2Client;
  try {
    oauthClient = await authenticate(logDebug, forceLogin);
  } catch (e: any) {
    spinner.fail(`Authentication failed: ${e.message}`);
    process.exit(1);
  }

  let accessToken: string;
  try {
    const { token } = await oauthClient.getAccessToken();
    if (!token)
      throw new Error("No access token returned after authentication.");
    accessToken = token;
  } catch (e: any) {
    spinner.fail(`Failed to retrieve access token: ${e.message}`);
    process.exit(1);
  }

  // --- Resolve the Cloud AI Companion project via loadCodeAssist ---
  // This is the project the user's account is onboarded to for Gemini Code Assist.
  const envProjectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    undefined;

  logDebug(
    `Calling loadCodeAssist to resolve Cloud AI Companion project (env hint: ${envProjectId ?? "none"})`,
  );

  let cloudaicompanionProject: string | undefined;
  try {
    const loadRes = await codeAssistPost(
      "loadCodeAssist",
      {
        cloudaicompanionProject: envProjectId,
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
          duetProject: envProjectId,
        },
      },
      accessToken,
      logDebug,
    );
    cloudaicompanionProject = loadRes?.cloudaicompanionProject ?? envProjectId;
    logDebug(`Resolved project: ${cloudaicompanionProject}`);
  } catch (e: any) {
    logDebug(
      `loadCodeAssist failed: ${e.message}. Falling back to env project.`,
    );
    cloudaicompanionProject = envProjectId;
  }

  if (!cloudaicompanionProject) {
    spinner.fail(
      "Could not determine project. Set GOOGLE_CLOUD_PROJECT in your .env file.",
    );
    process.exit(1);
  }

  spinner.succeed(`Authenticated with project: ${cloudaicompanionProject}`);
  spinner.start("Scanning repository for code files...");

  logDebug(`Scanning base directory: ${baseDir}`);
  const files = await scanCodeDirectory(baseDir);

  if (files.length === 0) {
    spinner.info("No valid source files found for review.");
    process.exit(0);
  }

  const outputDir = path.join(baseDir, "gemini-code-reviewer");
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      logDebug(
        `Could not create output directory ${outputDir}: ${err.message}`,
      );
    }
  }

  const statePath = path.join(outputDir, ".gemini-code-reviewer.json");
  let previousState: any = null;
  try {
    const rawState = await fs.readFile(statePath, "utf-8");
    previousState = JSON.parse(rawState);
  } catch (e) {}

  const currentFileHashes: Record<string, string> = {};
  const changedFiles: CodeFile[] = [];
  const unchangedFiles: string[] = [];

  for (const f of files) {
    const hash = crypto.createHash("sha256").update(f.content).digest("hex");
    currentFileHashes[f.filePath] = hash;
    if (
      previousState &&
      previousState.fileHashes &&
      previousState.fileHashes[f.filePath] === hash
    ) {
      unchangedFiles.push(f.filePath);
    } else {
      changedFiles.push(f);
    }
  }

  let oldFindings: any[] = [];
  if (previousState && previousState.findings) {
    oldFindings = previousState.findings.filter((finding: any) =>
      unchangedFiles.includes(finding.file),
    );
  }

  if (changedFiles.length === 0 && previousState) {
    spinner.succeed(
      "No files have changed since the last review. Using cached report.",
    );
    const consoleOutput = generateMarkdownReport(previousState, true);
    console.log("\n\n" + consoleOutput);
    process.exit(0);
  }

  spinner.succeed(
    `Found ${files.length} source files (${changedFiles.length} to scan).`,
  );
  spinner.start("Loading skills context (Markdowns)...");

  const skillsContext = await extractSkills(baseDir);
  spinner.succeed("Skills injected.");
  logDebug(`Skills context length: ${skillsContext.length} chars.`);

  // ---------------------------------------------------------------------------
  // Prepare segments and call Code Assist generateContent
  // ---------------------------------------------------------------------------
  const responseSchema = {
    type: "OBJECT",
    properties: {
      score: {
        type: "NUMBER",
        description:
          "The logic and architectural score from 0 to 100 for this batch.",
      },
      codeDuplicationPercentage: {
        type: "NUMBER",
        description:
          "The estimated percentage of code duplication in this batch.",
      },
      cyclomaticComplexity: {
        type: "NUMBER",
        description: "The estimated average cyclomatic complexity.",
      },
      maintainabilityIndex: {
        type: "NUMBER",
        description: "The estimated maintainability index (0-100).",
      },
      findings: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            file: { type: "STRING", description: "The exact file path" },
            line: { type: "NUMBER", description: "Line number" },
            snippet: {
              type: "STRING",
              description: "The specific snippet being flagged",
            },
            suggestion: {
              type: "STRING",
              description:
                "Idea, bug, or refactoring suggestion based on skills",
            },
            category: {
              type: "STRING",
              description:
                "The focus area this finding belongs to (e.g., Naming, SOLID, Architecture, Performance, Other)",
            },
            priority: {
              type: "STRING",
              description: "Priority of the finding",
              enum: ["low", "medium", "high"],
            },
          },
          required: [
            "file",
            "line",
            "snippet",
            "suggestion",
            "category",
            "priority",
          ],
        },
      },
    },
    required: [
      "score",
      "codeDuplicationPercentage",
      "cyclomaticComplexity",
      "maintainabilityIndex",
      "findings",
    ],
  };

  function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  spinner.start("Chunking files into batch segments...");

  const segments: { payload: string; files: string[] }[] = [];
  let currentSegment = "Review the following code:\n\n";
  let currentFiles: string[] = [];

  for (const f of changedFiles) {
    const fileXml = `<file path="${f.filePath}">\n${f.content}\n</file>\n\n`;
    if (
      currentSegment.length + fileXml.length > CHAR_THRESHOLD &&
      currentSegment !== "Review the following code:\n\n"
    ) {
      segments.push({ payload: currentSegment, files: currentFiles });
      currentSegment = "Review the following code:\n\n" + fileXml;
      currentFiles = [f.filePath];
    } else {
      currentSegment += fileXml;
      currentFiles.push(f.filePath);
    }
  }

  if (currentSegment !== "Review the following code:\n\n") {
    segments.push({ payload: currentSegment, files: currentFiles });
  }

  logDebug(
    `Created ${segments.length} segments (~${CHAR_THRESHOLD} char limit).`,
  );

  if (debug) {
    const payloadFile = path.join(
      outputDir,
      ".gemini-code-reviewer.payload.json",
    );
    try {
      await fs.writeFile(
        payloadFile,
        JSON.stringify(segments, null, 2),
        "utf-8",
      );
      logDebug(`Debug payload chunks written to ${payloadFile}`);
    } catch (err: any) {
      logDebug(`Warning: Could not write debug payload file: ${err.message}`);
    }
  }

  spinner.succeed(`Created ${segments.length} segments for review.`);
  spinner.start("Calling Gemini Code Assist API to review code segments...");

  let totalScore = 0;
  let totalDuplication = 0;
  let totalComplexity = 0;
  let totalMaintainability = 0;
  const allFindings: any[] = [];
  let batchesSucceeded = 0;

  for (let i = 0; i < segments.length; i++) {
    try {
      const { payload: segmentPayload, files: segmentFiles } = segments[i];
      const progress = Math.round(((i + 1) / segments.length) * 100);

      spinner.text = `[${progress}%] Reviewing chunk ${i + 1}/${segments.length}...`;
      console.log(
        `\n[${progress}%] Chunk ${i + 1}/${segments.length} loaded to context:`,
      );
      segmentFiles.forEach((f) => console.log(`  - ${f}`));

      // Always use the flash model according to requirements
      const segmentModel = GeminiModel.FLASH;

      logDebug(
        `Segment ${i + 1}/${segments.length} — ~${estimateTokenCount(segmentPayload)} tokens, model: ${segmentModel}`,
      );

      // Request body following the Code Assist generateContent wire format:
      // { model, project, request: { contents, systemInstruction, generationConfig } }
      const systemPrompt = `You are an expert AI code reviewer.
Review the code thoroughly for:
- Naming conventions and semantic names
- SOLID principles and design patterns
- Code benchmarks and performance optimization
- Logic and architectural correctness

When finding issues, give a very small, specific 'snippet' (a few words or one statement) so we can accurately locate it in the codebase.
Additional context:
${skillsContext}`;

      const requestBody = {
        model: segmentModel,
        project: cloudaicompanionProject,
        request: {
          systemInstruction: {
            role: "system",
            parts: [{ text: systemPrompt }],
          },
          contents: [{ role: "user", parts: [{ text: segmentPayload }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema,
          },
        },
      };

      const json = await codeAssistPost(
        "generateContent",
        requestBody,
        accessToken,
        logDebug,
      );

      logDebug(`Response received for segment ${i + 1}.`);

      // Code Assist response: { response: { candidates: [...] } }
      const responseText: string =
        json?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      const reportData = JSON.parse(responseText);

      if (typeof reportData.score === "number") {
        totalScore += reportData.score;
        totalDuplication += reportData.codeDuplicationPercentage || 0;
        totalComplexity += reportData.cyclomaticComplexity || 0;
        totalMaintainability += reportData.maintainabilityIndex || 0;
        batchesSucceeded++;
      }

      if (reportData.findings && Array.isArray(reportData.findings)) {
        reportData.findings.forEach((finding: any) => {
          if (finding.file && finding.snippet) {
            const fileMatch = changedFiles.find(
              (f) => f.filePath === finding.file,
            );
            if (fileMatch) {
              finding.line = findLineNumberToMatchSnippet(
                fileMatch.originalContent,
                finding.snippet,
              );
            }
          } else if (!finding.line) {
            finding.line = 1; // Fallback
          }
        });
        allFindings.push(...reportData.findings);
      }
    } catch (err: any) {
      logDebug(`Error on segment ${i + 1}: ${err?.message || err}`);
    }
  }

  if (batchesSucceeded === 0 && segments.length > 0) {
    spinner.fail("Gemini API call failed for all batches.");
    process.exit(1);
  }

  spinner.succeed("Review complete!");

  const finalScore =
    batchesSucceeded > 0
      ? Math.round(totalScore / batchesSucceeded)
      : previousState?.score || 0;
  const finalDuplication =
    batchesSucceeded > 0
      ? totalDuplication / batchesSucceeded
      : previousState?.codeDuplicationPercentage || 0;
  const finalComplexity =
    batchesSucceeded > 0
      ? totalComplexity / batchesSucceeded
      : previousState?.cyclomaticComplexity || 0;
  const finalMaintainability =
    batchesSucceeded > 0
      ? totalMaintainability / batchesSucceeded
      : previousState?.maintainabilityIndex || 0;

  allFindings.push(...oldFindings);

  // Sort findings by priority (high > medium > low), then by file alphabetically, then by line
  const priorityMap: Record<string, number> = { high: 0, medium: 1, low: 2 };
  allFindings.sort((a, b) => {
    const pA = priorityMap[(a.priority || "low").toLowerCase()] ?? 3;
    const pB = priorityMap[(b.priority || "low").toLowerCase()] ?? 3;
    if (pA !== pB) return pA - pB;
    if (a.file !== b.file) return (a.file || "").localeCompare(b.file || "");
    return (a.line || 0) - (b.line || 0);
  });

  const finalReport: CodeReviewResponse = {
    score: finalScore,
    codeDuplicationPercentage: finalDuplication,
    cyclomaticComplexity: finalComplexity,
    maintainabilityIndex: finalMaintainability,
    findings: allFindings,
  };

  const newState = {
    ...finalReport,
    fileHashes: currentFileHashes,
  };
  try {
    await fs.writeFile(statePath, JSON.stringify(newState, null, 2), "utf-8");
  } catch (err: any) {
    logDebug(`Could not save cache to ${statePath}: ${err.message}`);
  }

  const consoleOutput = generateMarkdownReport(finalReport, true);
  console.log("\n\n" + consoleOutput);

  const markdownOutput = generateMarkdownReport(finalReport, false);
  const reportPath = path.join(outputDir, "gemini-code-reviewer.md");
  try {
    await fs.writeFile(reportPath, markdownOutput, "utf-8");
    console.log(`\nReport successfully saved to ${reportPath}`);
  } catch (err: any) {
    console.error(`\nFailed to save report to ${reportPath}:`, err.message);
  }
}
