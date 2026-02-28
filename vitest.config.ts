import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/core/entities/**",
        "src/core/interfaces/**",
        "src/shared/constants.ts",
        "src/index.ts",
        "src/presentation/cli/main.ts",
        "src/presentation/cli/DependencyContainer.ts",
        "src/infrastructure/auth/GoogleAuth.ts",
        "src/infrastructure/ai/GeminiAiProvider.ts",
        "src/application/BootstrapProject.ts",
        "src/shared/utils/Logger.ts",
        "src/**/__tests__/**",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 35,
        functions: 35,
        branches: 25,
        statements: 35,
      },
    },
  },
});
