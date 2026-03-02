import { describe, it, expect, vi, beforeEach } from "vitest";
import { LocalSkillRepository } from "../src/infrastructure/config/LocalSkillRepository.js";
import * as fs from "node:fs/promises";
import fg from "fast-glob";

vi.mock("node:fs/promises");
vi.mock("fast-glob");

describe("LocalSkillRepository", () => {
  let repo: any;

  beforeEach(() => {
    repo = new LocalSkillRepository();
    vi.clearAllMocks();
  });

  it("loads skills from discovered files", async () => {
    (fg as any).mockResolvedValue([
      "/abs/path/skill1.md",
      "/abs/path/skill2.md",
    ]);

    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes("skill1.md")) return Promise.resolve("# Skill 1 content");
      if (p.includes("skill2.md")) return Promise.resolve("# Skill 2 content");
      return Promise.reject(new Error("File not found"));
    });

    const context = await repo.loadSkillsContext("/base");

    expect(context).toContain("Skill 1 content");
    expect(context).toContain("Skill 2 content");
    expect(context).toContain("elite code reviewer");
  });

  it("returns default message if no skills are found", async () => {
    (fg as any).mockResolvedValue([]);
    const context = await repo.loadSkillsContext("/base");
    expect(context).toContain("No internal skills provided");
  });
});
