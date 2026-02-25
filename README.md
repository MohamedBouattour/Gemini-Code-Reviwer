# Gemini Code Reviewer

An AI-powered automated code reviewer powered by Google Gemini via the official `@google/genai` SDK. This CLI tool uses Application Default Credentials (ADC) to authenticate against your Google Cloud project and runs intelligent code review over your repository, using customized internal best practices via `Skills` files.

## Features

- **CLI-Native**: Simple to use with `gemini-code-reviewer` after global installation.
- **Smart Scanning**: Automatically ignores `node_modules`, standard build artifacts, tests (`*.spec.*`, `**/__tests__/**`), and scans only valid standard source directories (like `src/` and its nested subdirectories for React, JS, TS, Java, SCSS, etc.).
- **Skills Extraction**: Automatically searches for Markdown (`.md`) files in the repository root or `.skills/` directory to inject your team's specific guidelines directly into the Gemini system prompt.
- **Secure Authentication**: Does not require raw API keys. Instead relies on Google Auth Library (`ADC`) just like the gcloud CLI.

## Prerequisites

- Node.js (>=20.0.0)
- Google Cloud Project with the Vertex AI API enabled.
- `gcloud` CLI installed locally and authenticated.

### Authentication setup

Ensure you are using Application Default Credentials (ADC):

```bash
gcloud auth application-default login
```

Set your project context:

```bash
export GOOGLE_CLOUD_PROJECT="your-google-cloud-project-id"
# Optional: It can also be loaded via a local .env file.
```

## Installation & Setup

Locally link the tool:

```bash
npm install
npm run build
npm link
```

_Note: running `npm link` allows you to call `gemini-code-reviewer` globally from anywhere on your terminal._

## Usage

Run the reviewer in your target directory:

```bash
gemini-code-reviewer --dir /path/to/my/project
```

You can optionally specify the directory and the Google Cloud Location via options:

```bash
gemini-code-reviewer -d ./src -l europe-west4
```

## Architecture

- **cli.ts**: CLI interface logic using `commander`
- **scanner.ts**: Analyzes files using `fast-glob` ensuring tests and ignored files aren't scanned.
- **skills.ts**: Searches and concatenates company guidelines from `*.md` files.
- **reviewer.ts**: Interfaces natively with Google GenAI SDK to interact with the Vertex AI `gemini-1.5-pro` model.
- **formatter.ts**: Parses the robust JSON schema output and beautifully renders it.

## Output Example

The tool intelligently scans the repo, invokes the Gemini API and outputs formatted Markdown or Console reports with:

1. **Overall Score** (e.g. 85/100)
2. **List of Findings**: Highlighting files, precise lines, code snippets, and custom refactoring suggestions.
