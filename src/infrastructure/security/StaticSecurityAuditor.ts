// Copyright 2026 Google LLC

/**
 * StaticSecurityAuditor — IProjectAuditor for local SAST (zero LLM cost).
 *
 * Scans all code files for hardcoded secrets using regex patterns.
 * Runs before any AI call to provide fast, deterministic detection.
 *
 * Plugs into the auditor pipeline via IProjectAuditor.
 * Adding this auditor to DependencyContainer requires zero changes to RunCodeReview.
 */

import type {
  IProjectAuditor,
  AuditContext,
  AuditResult,
} from "../../core/interfaces/IProjectAuditor.js";
import type { SecretFindingEntity } from "../../core/entities/ProjectReport.js";

// ─────────────────────────────────────────────────────────────────────────────
// Secret pattern registry
// ─────────────────────────────────────────────────────────────────────────────

type SecretSeverity = "critical" | "high";

interface SecretRule {
  type: string;
  label: string;
  pattern: RegExp;
  severity: SecretSeverity;
}

const SECRET_RULES: SecretRule[] = [
  {
    type: "aws-access-key",
    label: "AWS Access Key ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "critical",
  },
  {
    type: "aws-secret-key",
    label: "AWS Secret Access Key",
    pattern:
      /(?:aws[_-]?secret[_-]?access[_-]?key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']([A-Za-z0-9/+=]{40})["']/gi,
    severity: "critical",
  },
  {
    type: "gcp-api-key",
    label: "Google / GCP API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    severity: "critical",
  },
  {
    type: "github-token",
    label: "GitHub Personal Access Token",
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
    severity: "critical",
  },
  {
    type: "stripe-secret-key",
    label: "Stripe Secret Key",
    pattern: /\bsk_live_[0-9a-zA-Z]{24,}\b/g,
    severity: "critical",
  },
  {
    type: "sendgrid-key",
    label: "SendGrid API Key",
    pattern: /\bSG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}\b/g,
    severity: "high",
  },
  {
    type: "slack-token",
    label: "Slack Token",
    pattern: /\bxox[baprs]-[0-9a-zA-Z\-]{10,}/g,
    severity: "high",
  },
  {
    type: "twilio-key",
    label: "Twilio API Key",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
    severity: "high",
  },
  {
    type: "pem-private-key",
    label: "PEM Private Key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: "critical",
  },
  {
    type: "database-url",
    label: "Hardcoded Database URL (with credentials)",
    pattern:
      /\b(?:mongodb|postgresql|mysql|redis|amqps?):\/\/[^:@\s]+:[^@\s]{4,}@[^\s"']+/gi,
    severity: "critical",
  },
  {
    type: "hardcoded-password",
    label: "Hardcoded Password",
    pattern:
      /\b(?:password|passwd|pwd)\s*[:=]\s*["'](?!.*\$\{|.*process\.env)[^"']{6,}["']/gi,
    severity: "high",
  },
  {
    type: "hardcoded-bearer-token",
    label: "Hardcoded Bearer / Authorization Token",
    pattern: /[Aa]uthorization\s*:\s*["']Bearer\s+[A-Za-z0-9\-._~+/]+=*["']/g,
    severity: "high",
  },
  {
    type: "generic-api-key",
    label: "Generic Hardcoded API Key",
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|x[_-]api[_-]key)\s*[:=]\s*["'](?!.*\$\{|.*process\.env)[^"']{16,}["']/gi,
    severity: "high",
  },
  {
    type: "generic-secret",
    label: "Generic Hardcoded Secret / Token",
    pattern:
      /\b(?:secret|token|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'](?!.*\$\{|.*process\.env)[^"']{20,}["']/gi,
    severity: "high",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// StaticSecurityAuditor
// ─────────────────────────────────────────────────────────────────────────────

export class StaticSecurityAuditor implements IProjectAuditor {
  readonly name = "Secrets pre-scan (SAST)";

  async audit(context: AuditContext): Promise<AuditResult> {
    const secretFindings: SecretFindingEntity[] = [];

    for (const file of context.codeFiles) {
      for (const rule of SECRET_RULES) {
        rule.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = rule.pattern.exec(file.originalContent)) !== null) {
          const lineNumber = this.findLineNumber(
            file.originalContent,
            match.index,
          );
          secretFindings.push({
            file: file.filePath,
            line: lineNumber,
            patternType: rule.type,
            label: rule.label,
            snippet: this.redact(match[0]),
            severity: rule.severity,
          });
        }

        rule.pattern.lastIndex = 0;
      }
    }

    // Sort: critical first, then by file, then by line
    secretFindings.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return a.file.localeCompare(b.file) || a.line - b.line;
    });

    return { secretFindings };
  }

  private findLineNumber(content: string, matchIndex: number): number {
    const before = content.slice(0, matchIndex);
    return (before.match(/\n/g) ?? []).length + 1;
  }

  private redact(value: string): string {
    if (value.length <= 10) return "***";
    return value.slice(0, 10) + "***[REDACTED]";
  }
}
