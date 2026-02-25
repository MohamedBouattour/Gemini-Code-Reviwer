// Copyright 2026 Google LLC

import chalk from "chalk";

export interface CodeFinding {
  file: string;
  line: number;
  snippet: string;
  suggestion: string;
  priority: "low" | "medium" | "high";
}

export interface CodeReviewResponse {
  score: number;
  findings: CodeFinding[];
}

export function generateMarkdownReport(data: CodeReviewResponse): string {
  if (!data) return "Error generating report format.";

  let scoreColor = chalk.green;
  if (data.score < 70) scoreColor = chalk.yellow;
  if (data.score < 50) scoreColor = chalk.red;

  let report = `# AI Code Review Report\n\n`;
  report += `**Overall Logic & Architecture Score:** ${scoreColor(data.score.toString() + "/100")}\n\n`;

  if (!data.findings || data.findings.length === 0) {
    report += `*No findings! Excellent code structure.*`;
    return report;
  }

  report += `## Findings\n\n`;

  for (const [index, finding] of data.findings.entries()) {
    let priorityColor = chalk.blue;
    if (finding.priority === "medium") priorityColor = chalk.yellow;
    if (finding.priority === "high") priorityColor = chalk.red;
    const priorityLabel = priorityColor(`[${finding.priority.toUpperCase()}]`);

    report += `### ${index + 1}. File: \`${finding.file}\` (Line: ${finding.line}) ${priorityLabel}\n`;
    report += `\n**Code Snippet:**\n\`\`\`\n${finding.snippet}\n\`\`\`\n`;
    report += `**Suggestion:**\n${finding.suggestion}\n\n`;
    report += `---\n\n`;
  }

  return report;
}
