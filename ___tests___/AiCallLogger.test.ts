import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AiCallLogger, AI_CALL_LOG_SUBDIR } from "../src/infrastructure/ai/AiCallLogger.js";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("AiCallLogger", () => {
  const outputDir = "/test/output";
  const logDebug = vi.fn();
  let logger: AiCallLogger;

  beforeEach(() => {
    logger = new AiCallLogger(outputDir, logDebug);
    vi.clearAllMocks();
  });

  it("should construct the correct log directory path", () => {
    expect((logger as unknown as { logDir: string }).logDir).toBe(
      path.join(outputDir, AI_CALL_LOG_SUBDIR)
    );
  });

  it("should persist a call record correctly", async () => {
    const callName = "testCall";
    const model = "test-model";
    const payload = { input: "data" };
    const response = { output: "result" };
    const durationMs = 100;
    const estimatedInputTokens = 50;
    const retryCount = 1;

    logger.persist(
      callName,
      model,
      payload,
      response,
      durationMs,
      estimatedInputTokens,
      retryCount
    );

    // Give it a micro-tick for the fire-and-forget writeRecord to be called
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fs.mkdir).toHaveBeenCalledWith(
      path.join(outputDir, AI_CALL_LOG_SUBDIR),
      { recursive: true }
    );

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(callName + ".json"),
      expect.stringContaining('"call": "testCall"'),
      "utf-8"
    );

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("[AiCallLogger] \u2192"));
  });

  it("should handle write failures gracefully", async () => {
    const error = new Error("Write failed");
    vi.mocked(fs.writeFile).mockRejectedValueOnce(error);

    logger.persist("failCall", "model", {}, {}, 0, 0);

    // Wait for the async writeRecord to fail
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining("[AiCallLogger] Failed to write")
    );
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining("Write failed")
    );
  });
});
