import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigurationAuditor } from "../src/infrastructure/config/ConfigurationAuditor.js";

describe("ConfigurationAuditor", () => {
  let auditor: any;
  let mockAiProvider: any;

  beforeEach(() => {
    mockAiProvider = {
      reviewProject: vi.fn().mockResolvedValue({
        codeFindings: [],
        infraFindings: [],
        subScores: {},
      }),
    };
    auditor = new ConfigurationAuditor(mockAiProvider);
  });

  it("returns no-op result (infra scanning moved to reviewProject)", async () => {
    const context: any = {
      ciFiles: {},
      iacFiles: {
        "deploy.yaml": "ingress: public\nloadBalancerSourceRanges: [0.0.0.0/0]",
      },
      dependencyManifests: {},
      isPublicFacing: false,
    };

    const result = await auditor.audit(context);
    // ConfigurationAuditor is now a no-op; infra findings come from reviewProject()
    expect(result.infraFindings).toEqual([]);
    expect(result.scannedFiles).toEqual([]);
  });

  it("returns undefined for isPublicFacing (deferred to reviewProject)", async () => {
    const context: any = {
      ciFiles: {},
      iacFiles: {
        "main.tf":
          'resource "google_compute_firewall" "allow-all" {\n source_ranges = ["0.0.0.0/0"]\n }',
      },
      dependencyManifests: {},
      isPublicFacing: false,
    };

    const result = await auditor.audit(context);
    expect(result.isPublicFacing).toBeUndefined();
  });

  it("returns empty results when no files provided", async () => {
    const context: any = {
      ciFiles: {},
      iacFiles: {},
      dependencyManifests: {},
      isPublicFacing: false,
    };

    const result = await auditor.audit(context);
    expect(result.infraFindings).toEqual([]);
    expect(result.scannedFiles).toEqual([]);
  });
});
