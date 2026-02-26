// Copyright 2026 Google LLC

/**
 * exposureDetector — pure function for detecting internet-facing infrastructure.
 *
 * Extracted from security-scanner.ts so it can be shared by the
 * InfraAuditorAdapter and ProjectScanner without circular imports.
 */

const PUBLIC_KEYWORDS = [
  "0.0.0.0/0",
  "allow: all",
  "allow_all",
  "public: true",
  "ingress:",
  "expose:",
  "publicIp",
  "LoadBalancer",
  "annotations.*external",
  "acl: public-read",
];

/**
 * Checks CI/CD and IaC config content for keywords that suggest the service is
 * internet-facing (e.g. public ingress rules, "allow: all", "0.0.0.0").
 */
export function detectPublicExposure(ciContents: string[]): boolean {
  const combined = ciContents.join("\n").toLowerCase();
  return PUBLIC_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()));
}
