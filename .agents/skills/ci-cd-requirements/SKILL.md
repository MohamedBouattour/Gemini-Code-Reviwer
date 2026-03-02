---
name: ci-cd-requirements
description: Requirements for Continuous Integration and Deployment pipelines.
---

## 1. CI Pipeline Requirements

Any pull request or merge to the `main` branch must trigger a CI pipeline (e.g., GitHub Actions) that executes the following steps. The pipeline must fail if any of these steps fail.

1.  **Environment Setup**:
    - The job must run on a Linux environment.
    - The Node.js version must satisfy the `engines` field in `package.json` (`>=20.0.0`).

2.  **Dependency Installation**:
    - Install dependencies using `npm ci`. This provides faster, more reliable builds than `npm install`.

3.  **Code Quality Checks**:
    - **Linting**: Run `npm run lint`. The build must fail if there are any ESLint errors.
    - **Formatting**: While not a blocking check, it's recommended to run `npx prettier --check src` to ensure code was formatted before submission.

4.  **Testing**:
    - **Unit Tests**: Run `npm run test`. All Vitest tests must pass.
    - **Coverage**: The test command will output a coverage summary. The pipeline should be configured to fail if coverage drops below the thresholds defined in `vitest.config.ts`.

5.  **Build**:
    - **Compilation**: Run `npm run build`. The TypeScript code must compile to JavaScript in the `dist/` directory without any errors.

## 2. Secrets Management

- The project uses a `.env` file for local development secrets (e.g., Google API keys).
- This file is listed in `.gitignore` and **must never** be committed to the repository.
- In the CI/CD environment, secrets must be provided as secure environment variables (e.g., GitHub Actions Secrets).

## 3. Release & Publishing Workflow

Releasing a new version to NPM should be an automated process triggered by creating a new tag or a manual workflow dispatch.

1.  **Authentication**: The pipeline must be configured with an NPM access token (`NPM_TOKEN`) to authenticate with the npm registry.

2.  **Version Bump**: The `package.json` version should be incremented according to [Semantic Versioning](https://semver.org/). This can be automated with `npm version <patch|minor|major>`.

3.  **Pre-Publish Checks**: The release pipeline must run all CI checks (`lint`, `test`, `build`) before publishing.

4.  **Publish**: If all checks pass, the pipeline should execute `npm publish`.

5.  **Artifacts**: The published artifact is the contents of the `dist/` directory, as defined in the `files` array of `package.json`. No other source code should be included in the published package.