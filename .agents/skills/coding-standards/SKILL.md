---
name: coding-standards
description: TypeScript, ESLint, Prettier, and code style guidelines for the project.
---

## 1. Language: TypeScript

- **Version**: The project uses TypeScript (`^5.5.3`). All new code must be written in TypeScript.
- **Strict Mode**: `tsconfig.json` is configured with `"strict": true`. All new code must be strictly typed. Avoid using `any` wherever possible. If `any` is necessary, add a comment explaining the reason.
- **ES Modules**: The project is an ES Module (`"type": "module"`). Use `import`/`export` syntax. Due to `"moduleResolution": "NodeNext"`, you must include the `.js` file extension in relative imports (e.g., `import { RunCodeReview } from './RunCodeReview.js';`).

## 2. Formatting & Linting

- **Formatter**: [Prettier](https://prettier.io/) (`^3.3.2`) is the single source of truth for all code formatting. Before committing code, run `npm run format` to ensure consistency.
- **Linter**: [ESLint](https://eslint.org/) (`^10.0.2`) is used for identifying problematic patterns in the code. The configuration is located in `eslint.config.ts` and utilizes `@typescript-eslint/eslint-plugin`.
  - Run `npm run lint` before committing to check for and fix violations.
  - All linting rules must pass for a pull request to be considered for merging.

## 3. Naming Conventions

Adhere to the established naming conventions to maintain code readability:

- **Interfaces**: Use a `I` prefix (e.g., `IFileScanner`, `IAiProvider`).
- **Classes & Types**: `PascalCase` (e.g., `RunCodeReview`, `ProjectReport`).
- **Methods & Functions**: `camelCase` (e.g., `execute`, `analyzeExistingSkills`).
- **Variables**: `camelCase`.
- **Constants**: `UPPER_SNAKE_CASE` for global, immutable constants (e.g., `CHUNK_SIZE_CHARS` in `src/shared/constants.ts`).
- **Filenames**: Use `PascalCase` for files that export a single class (e.g., `RunCodeReview.ts`).

## 4. Error Handling

- **Custom Domain Errors**: Do not throw generic `Error` objects for predictable failures. Use the specific, custom error classes defined in `src/core/domain-errors/ReviewerErrors.ts` (e.g., `AuthenticationError`, `NoSourceFilesError`).
- **Inheritance**: All custom errors must extend the base `ReviewerError` class. This allows the presentation layer (`cli/main.ts`) to catch and handle all application-specific errors gracefully.

## 5. Code Structure

- **Constants**: Place all shared, application-wide constants in `src/shared/constants.ts`. Avoid magic strings or numbers in business logic files.
- **Copyright Header**: All new source files must begin with the `// Copyright 2026 Google LLC` header.
- **Documentation**: Write JSDoc-style comments for all public classes, methods, and complex functions to explain their purpose, parameters, and return values.