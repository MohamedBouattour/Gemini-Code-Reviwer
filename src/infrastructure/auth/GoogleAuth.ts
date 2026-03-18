// Copyright 2026 Google LLC

import { OAuth2Client } from "google-auth-library";
import * as http from "node:http";
import url from "node:url";
import crypto from "node:crypto";
import open from "open";
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  OAUTH_SCOPE,
  HTTP_REDIRECT,
  SIGN_IN_SUCCESS_URL,
  SIGN_IN_FAILURE_URL,
  CODE_ASSIST_BASE_URL,
} from "../../shared/constants.js";

import { Storage } from "@google/gemini-cli-core/dist/src/config/storage.js";
import { getAvailablePort } from "@google/gemini-cli-core/dist/src/code_assist/oauth2.js";

// ---------------------------------------------------------------------------
// OAuth credentials
// ---------------------------------------------------------------------------

interface OAuthCoreCredentials {
  clientId: string;
  clientSecret: string;
}

let _cachedCoreCredentials: OAuthCoreCredentials | null = null;

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
      "Could not extract OAuth credentials from @google/gemini-cli-core.",
    );
  }

  _cachedCoreCredentials = {
    clientId: idMatch[1],
    clientSecret: secretMatch[1],
  };
  return _cachedCoreCredentials;
}

async function loadCachedCredentials(
  logDebug: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  const credsPath = Storage.getOAuthCredsPath();
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
  const credsPath = Storage.getOAuthCredsPath();
  const dir = Storage.getGlobalGeminiDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(credsPath, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    logDebug(`Saved OAuth credentials to ${credsPath}`);
  } catch (e: unknown) {
    logDebug(
      `Warning: could not persist credentials: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

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
          reject(new Error("OAuth callback not received."));
          return;
        }
        const qs = new url.URL(req.url!, "http://127.0.0.1:3000").searchParams;
        if (qs.get("error")) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
          res.end();
          reject(new Error(`Google OAuth error: ${qs.get("error")}`));
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
              tokens as Record<string, unknown>,
              logDebug,
            );
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL });
            res.end();
            resolve(client);
          } catch (error: unknown) {
            res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL });
            res.end();
            reject(
              new Error(
                `Failed to exchange short-lived code: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        } else {
          reject(new Error("No authorization code received."));
        }
      } catch (e: unknown) {
        reject(e);
      } finally {
        server.close();
      }
    });

    server.listen(port, host, async () => {
      logDebug(`Launching browser OAuth: ${authUrl}`);
      console.log(`\nOpening browser for Google authentication...\n`);
      try {
        await open(authUrl);
      } catch {
        console.log(`\nCould not open browser. Visiter:\n\n${authUrl}\n`);
      }
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

async function clearCachedCredentials(
  logDebug: (msg: string) => void,
): Promise<void> {
  const credsPath = Storage.getOAuthCredsPath();
  try {
    await fs.rm(credsPath, { force: true });
    logDebug(`Cleared cached credentials at ${credsPath}`);
  } catch (e: unknown) {
    logDebug(
      `Could not clear credentials: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function authenticate(
  logDebug: (msg: string) => void,
  forceLogin: boolean = false,
): Promise<OAuth2Client> {
  const { clientId, clientSecret } = getCoreOAuthCredentials();

  if (!forceLogin) {
    const cached = await loadCachedCredentials(logDebug);
    if (cached) {
      const client = new OAuth2Client(clientId, clientSecret);
      client.setCredentials(cached as Record<string, unknown>);
      try {
        const { token } = await client.getAccessToken();
        if (token) {
          logDebug("Reused cached credentials successfully.");
          return client;
        }
      } catch (e: unknown) {
        logDebug(
          `Cached credentials invalid: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } else {
    logDebug("--login flag set, clearing cached credentials.");
    await clearCachedCredentials(logDebug);
  }

  logDebug("Launching browser OAuth flow...");
  return browserOAuthFlow(logDebug);
}

// ---------------------------------------------------------------------------
// Cloud Project Resolution
// ---------------------------------------------------------------------------

async function simpleCodeAssistPost(
  method: string,
  body: unknown,
  token: string,
  logDebug: (msg: string) => void,
): Promise<unknown> {
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resolveCloudProject(
  accessToken: string,
  logDebug: (msg: string) => void,
): Promise<string> {
  const envProjectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    undefined;

  logDebug(
    `Calling loadCodeAssist to resolve Cloud AI Companion project (env hint: ${
      envProjectId ?? "none"
    })`,
  );

  let cloudaicompanionProject: string | undefined;
  try {
    const loadRes = await simpleCodeAssistPost(
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
    cloudaicompanionProject =
      ((loadRes as Record<string, unknown>)?.cloudaicompanionProject as
        | string
        | undefined) ?? envProjectId;
    logDebug(`Resolved project: ${cloudaicompanionProject}`);
  } catch (e: unknown) {
    logDebug(
      `loadCodeAssist failed: ${e instanceof Error ? e.message : String(e)}. Falling back to env project.`,
    );
    cloudaicompanionProject = envProjectId;
  }

  if (!cloudaicompanionProject) {
    throw new Error(
      "Could not determine project. Set GOOGLE_CLOUD_PROJECT in your .env file.",
    );
  }

  return cloudaicompanionProject;
}
