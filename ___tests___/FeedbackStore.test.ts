import { describe, it, expect, vi, beforeEach } from "vitest";
import * as nodefs from "node:fs/promises";
import * as path from "node:path";
import { FeedbackStore, fingerprintFinding } from "../src/infrastructure/persistence/FeedbackStore.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("FeedbackStore", () => {
  const baseDir = "/test/project";
  let store: FeedbackStore;

  beforeEach(() => {
    store = new FeedbackStore(baseDir);
    vi.clearAllMocks();
  });

  describe("fingerprintFinding", () => {
    it("should generate a deterministic 16-char fingerprint", () => {
      const f1 = fingerprintFinding("file.ts", 10, "const x = 1");
      const f2 = fingerprintFinding("file.ts", 10, "const x = 1");
      const f3 = fingerprintFinding("other.ts", 10, "const x = 1");

      expect(f1).toBe(f2);
      expect(f1).not.toBe(f3);
      expect(f1).toHaveLength(16);
    });
  });

  describe("load/save", () => {
    it("should load entries from disk", async () => {
      const data = {
        version: 1,
        entries: [
          {
            id: "fp123",
            markedAt: new Date().toISOString(),
            file: "src/index.ts",
            line: 5,
            snippetPreview: "bad code",
          },
        ],
      };
      vi.mocked(nodefs.readFile).mockResolvedValue(JSON.stringify(data));

      await store.load();
      expect(store.hasFeedback).toBe(true);
      expect(store.entries).toHaveLength(1);
    });

    it("should handle missing file during load", async () => {
      vi.mocked(nodefs.readFile).mockRejectedValue(new Error("File not found"));
      await store.load();
      expect(store.hasFeedback).toBe(false);
    });

    it("should save entries to disk", async () => {
      await store.markFalsePositive({
        file: "test.ts",
        line: 1,
        snippetPreview: "snippet",
      });

      expect(nodefs.mkdir).toHaveBeenCalled();
      expect(nodefs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("feedback.json"),
        expect.stringContaining("test.ts"),
        "utf-8"
      );
    });
  });

  describe("isFalsePositive", () => {
    it("should return true for matched findings", async () => {
      const entry = {
        file: "match.ts",
        line: 42,
        snippetPreview: "const x = 123",
      };
      await store.markFalsePositive(entry);

      expect(store.isFalsePositive(entry.file, entry.line, entry.snippetPreview)).toBe(true);
      expect(store.isFalsePositive("other.ts", 42, "const x = 123")).toBe(false);
    });
  });

  describe("buildSystemPromptSuffix", () => {
    it("should return empty string if no feedback", () => {
      expect(store.buildSystemPromptSuffix()).toBe("");
    });

    it("should build a prompt suffix if feedback exists", async () => {
      await store.markFalsePositive({
        file: "bug.ts",
        line: 10,
        snippetPreview: "oops",
        note: "Not a bug",
      });

      const suffix = store.buildSystemPromptSuffix();
      expect(suffix).toContain("bug.ts");
      expect(suffix).toContain("oops");
      expect(suffix).toContain("Not a bug");
    });
  });
});
