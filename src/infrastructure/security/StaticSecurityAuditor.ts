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
    label: "AWS Access Key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: "critical",
  },
  {
    type: "generic-api-key",
    label: "Generic API Key",
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?([A-Za-z0-9_\-]{20,})/gi,
    severity: "critical",
  },
  {
    type: "pem-private-key",
    label: "Private Key PEM",
    pattern: /-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
    severity: "critical",
  },
  {
    type: "bearer-token",
    label: "Bearer Token",
    pattern: /bearer\s+[A-Za-z0-9\-._~+/]{20,}/gi,
    severity: "critical",
  },
  {
    type: "database-url",
    label: "DB Connection",
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@/gi,
    severity: "critical",
  },
  {
    type: "hardcoded-password",
    label: "Hardcoded Password",
    pattern:
      /(?:password|passwd|pwd)\s*[:=]\s*(?:["']|)(?!process\.env|process\[|window\.|document\.|.*\$)([^\s"']{8,})(?:["']|)/gi,
    severity: "critical",
  },
  {
    type: "github-token",
    label: "GitHub Token",
    pattern: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}/g,
    severity: "critical",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// StaticSecurityAuditor
// ─────────────────────────────────────────────────────────────────────────────

export class StaticSecurityAuditor implements IProjectAuditor {
  readonly name = "Secrets pre-scan (SAST)";

  async audit(context: AuditContext): Promise<AuditResult> {
    const secretFindings: SecretFindingEntity[] = [];

    // METHOD 1: Regex scan
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

      // METHOD 2: Shannon Entropy
      const stringLiterals = this.extractStringLiterals(file.originalContent);
      for (const literal of stringLiterals) {
        if (
          literal.value.length > 20 &&
          this.calculateEntropy(literal.value) > 4.5 &&
          !this.isUrlPathOrImport(literal.value)
        ) {
          secretFindings.push({
            file: file.filePath,
            line: literal.line,
            patternType: "high-entropy-string",
            label: "High Entropy String",
            snippet: this.redact(literal.value),
            severity: "critical",
          });
        }
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

  private extractStringLiterals(
    content: string,
  ): Array<{ value: string; line: number }> {
    const literals: Array<{ value: string; line: number }> = [];
    const lines = content.split("\n");
    const regex = /(["'`])((?:(?=(\\?))\3.)*?)\1/g;

    for (let i = 0; i < lines.length; i++) {
      let match;
      while ((match = regex.exec(lines[i])) !== null) {
        literals.push({ value: match[2], line: i + 1 });
      }
    }
    return literals;
  }

  private calculateEntropy(str: string): number {
    const len = str.length;
    const frequencies: Record<string, number> = {};
    for (let i = 0; i < len; i++) {
      const char = str[i];
      frequencies[char] = (frequencies[char] || 0) + 1;
    }

    return Object.values(frequencies).reduce((sum, freq) => {
      const p = freq / len;
      return sum - p * Math.log2(p);
    }, 0);
  }

  private isUrlPathOrImport(str: string): boolean {
    if (/^https?:\/\//i.test(str)) return true;
    if (/^[\w.\-\/]+\/[\w.\-\/]+$/.test(str)) return true;
    if (/^@[a-z0-9-]+\/[a-z0-9-]+$/i.test(str)) return true;
    return false;
  }
}
