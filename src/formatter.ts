// Copyright 2026 Google LLC

import chalk from "chalk";

export interface CodeFinding {
  file: string;
  line: string;
  code: string;
  feedback: string;
}

export interface CodeReviewResponse {
  overallScore: number;
  findings: CodeFinding[];
}

export function generateMarkdownReport(data: CodeReviewResponse): string {
  if (!data) return "Error generating report format.";

  let scoreColor = chalk.green;
  if (data.overallScore < 70) scoreColor = chalk.yellow;
  if (data.overallScore < 50) scoreColor = chalk.red;

  let report = `# AI Code Review Report\n\n`;
  report += `**Overall Logic & Architecture Score:** ${scoreColor(data.overallScore.toString() + "/100")}\n\n`;

  if (!data.findings || data.findings.length === 0) {
    report += `*No findings! Excellent code structure.*`;
    return report;
  }

  report += `## Findings\n\n`;

  for (const [index, finding] of data.findings.entries()) {
    report += `### ${index + 1}. File: \`${finding.file}\` (Lines: ${finding.line})\n`;
    report += `\n**Code Snippet:**\n\`\`\`\n${finding.code}\n\`\`\`\n`;
    report += `**Feedback / Suggestion:**\n${finding.feedback}\n\n`;
    report += `---\n\n`;
  }

  return report;
}
