# 🤖 Gemini Code Reviewer

[![npm version](https://img.shields.io/npm/v/gemini-code-reviewer.svg)](https://www.npmjs.com/package/gemini-code-reviewer)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-black?logo=github)](https://github.com/MohamedBouattour/Gemini-Code-Reviwer)

**Gemini Code Reviewer** is a powerful CLI tool that brings the intelligence of Google Gemini to your code review workflow. It automatically analyzes your source code, identifies potential bugs, security vulnerabilities, and stylistic improvements, and provides actionable feedback based on industry best practices and your team's specific guidelines.

---

## 🚀 Features

- **🧠 AI-Powered Analysis**: Leverages Google Gemini (1.5 Pro) for deep code understanding.
- **🔍 Smart Scanning**: Automatically identifies source files while ignoring build artifacts, `node_modules`, and test files.
- **💡 Skill Injection**: Injects custom team guidelines from `.md` files directly into the AI's logic.
- **🛡️ Secure Auth**: Uses Google Cloud Application Default Credentials (ADC) — no raw API keys required.
- **📊 Detailed Reports**: Generates comprehensive Markdown reports with scoring and line-by-line findings.
- **🛠️ Developer First**: Built with TypeScript and designed to fit seamlessly into any terminal-based workflow.

---

## 📦 Installation

Install the package globally via npm:

```bash
npm install -g gemini-code-reviewer
```

---

## ⚙️ Prerequisites & Setup

### 1. Google Cloud Setup

Ensure you have a Google Cloud Project with the **Vertex AI API** enabled.

### 2. Authentication

This tool uses **Application Default Credentials (ADC)**. Authenticate using the `gcloud` CLI:

```bash
gcloud auth application-default login
```

### 3. Environment Configuration

Set your Google Cloud Project ID:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
```

_(Alternatively, you can provide this in a local `.env` file.)_

---

## 📖 Usage

Run the reviewer in your project directory:

```bash
gemini-code-reviewer
```

### Options

| Option       | Shorthand | Description                                  |
| :----------- | :-------- | :------------------------------------------- |
| `--dir`      | `-d`      | Target directory to scan (default: `.`)      |
| `--location` | `-l`      | Google Cloud region (default: `us-central1`) |
| `--debug`    |           | Enable verbose logging for debugging         |

---

## 🏗️ Architecture

The project follows a Clean Architecture approach:

- **Core**: Contains the business logic and AI orchestration.
- **Infrastructure**: Handles file system scanning and Gemini API communication.
- **Presentation**: CLI interface and report formatting.
- **Application**: Coordinates between the CLI and the core logic.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

For bug reports and feature requests, please use the [GitHub Issues](https://github.com/MohamedBouattour/Gemini-Code-Reviwer/issues).

---

## 📄 License

This project is licensed under the Apache-2.0 License.

---

**Built with ❤️ by [Mohamed Bouattour](https://github.com/MohamedBouattour)**  
🔗 [GitHub Repository](https://github.com/MohamedBouattour/Gemini-Code-Reviwer)
