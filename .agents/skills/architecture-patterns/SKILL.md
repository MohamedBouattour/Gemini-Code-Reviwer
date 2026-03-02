---
name: architecture-patterns
description: The project's Clean Architecture, layers, and dependency injection patterns.
---

## 1. Core Pattern: Clean Architecture

This project is built using the principles of **Clean Architecture** (also known as Hexagonal or Ports & Adapters Architecture). The goal is to separate business logic from infrastructure details like frameworks, databases, and APIs.

**The Dependency Rule**: Source code dependencies must always point inwards, from outer layers to inner layers. An inner layer cannot know anything about an outer layer.

- `core` ← `application` ← `infrastructure` & `presentation`

## 2. Layer Breakdown

The `src/` directory is organized by architectural layer:

### `src/core` (The Domain)
This is the center of the application. It contains enterprise-wide business logic and has zero dependencies on any other layer in the project.
- **`entities/`**: Plain TypeScript objects representing the core concepts (e.g., `ProjectReport`, `ReviewFinding`).
- **`interfaces/`**: The "Ports". These define the contracts that outer layers must implement (e.g., `IAiProvider`, `IFileScanner`, `ISkillRepository`).
- **`domain-errors/`**: Custom, specific error types for the application's domain (e.g., `ApiError`).

### `src/application` (The Use Cases)
This layer orchestrates the flow of data and triggers the core domain logic. It depends only on `core`.
- Contains application-specific business rules. Each file represents a single use case (e.g., `RunCodeReview.ts`, `BootstrapProject.ts`).
- These classes depend on the interfaces from `core`, not on concrete implementations.

### `src/infrastructure` (The Adapters)
This layer contains the concrete implementations of the interfaces defined in `core`. It depends on `core` and external libraries (e.g., `@google/genai`, `fast-glob`).
- **`ai/GeminiProvider.ts`**: Implements the `IAiProvider` interface by making calls to the Google Gemini API.
- **`filesystem/FileSystemScanner.ts`**: Implements the `IFileScanner` interface using Node.js `fs` and `fast-glob`.
- **`config/LocalSkillRepository.ts`**: Implements the `ISkillRepository` interface for reading/writing skill files.

### `src/presentation` (The UI/Entrypoint)
This is the outermost layer, responsible for interacting with the user or external systems.
- **`cli/`**: The command-line interface, built using `commander.js`. `main.ts` is the application entry point.
- **`report/`**: Contains logic for building the final user-facing output (e.g., `ReportBuilder.ts`).

## 3. Dependency Injection (DI)

To adhere to the Dependency Rule, we use **Constructor Injection**.
- Classes do not create their own dependencies (e.g., `RunCodeReview` does not do `new GeminiProvider()`).
- Instead, dependencies are passed into the constructor.
- The `src/presentation/cli/DependencyContainer.ts` class acts as the **Composition Root**. It is the single place in the application where concrete classes are instantiated and the entire object graph is assembled.