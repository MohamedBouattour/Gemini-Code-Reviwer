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
  codeDuplicationPercentage: number;
  cyclomaticComplexity: number;
  maintainabilityIndex: number;
  findings: CodeFinding[];
}

export function generateMarkdownReport(
  data: CodeReviewResponse,
  useChalk: boolean = false,
): string {
  if (!data) return "Error generating report format.";

  let scoreText = data.score.toString() + "/100";
  if (useChalk) {
    let scoreColor = chalk.green;
    if (data.score < 70) scoreColor = chalk.yellow;
    if (data.score < 50) scoreColor = chalk.red;
    scoreText = scoreColor(scoreText);
  }

  let report = `# AI Code Review Report\n\n`;
  report += `**Overall Logic & Architecture Score:** ${scoreText}\n`;
  report += `**Code Duplication:** ${data.codeDuplicationPercentage.toFixed(2)}%\n`;
  report += `**Average Cyclomatic Complexity:** ${data.cyclomaticComplexity.toFixed(2)}\n`;
  report += `**Maintainability Index:** ${data.maintainabilityIndex.toFixed(2)}/100\n\n`;

  if (!data.findings || data.findings.length === 0) {
    report += `*No findings! Excellent code structure.*`;
    return report;
  }

  report += `## Findings\n\n`;

  for (const [index, finding] of data.findings.entries()) {
    let priorityLabel = `[${finding.priority.toUpperCase()}]`;
    if (useChalk) {
      let priorityColor = chalk.blue;
      if (finding.priority === "medium") priorityColor = chalk.yellow;
      if (finding.priority === "high") priorityColor = chalk.red;
      priorityLabel = priorityColor(priorityLabel);
    }

    report += `### ${index + 1}. File: \`${finding.file}\` (Line: ${finding.line}) ${priorityLabel}\n`;
    report += `\n**Code Snippet:**\n\`\`\`\n${finding.snippet}\n\`\`\`\n`;
    report += `**Suggestion:**\n${finding.suggestion}\n\n`;
    report += `---\n\n`;
  }

  return report;
}
