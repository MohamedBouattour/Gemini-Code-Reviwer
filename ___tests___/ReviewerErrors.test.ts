import { describe, it, expect } from "vitest";
import {
  NoSourceFilesError,
  AllBatchesFailedError,
  ReviewerError,
  ApiError,
} from "../src/core/domain-errors/ReviewerErrors.js";

describe("ReviewerErrors", () => {
  it("creates ReviewerError", () => {
    const err = new ReviewerError("Base error", new Error("cause"));
    expect(err.message).toBe("Base error");
    expect(err.cause).toBeDefined();
  });

  it("creates NoSourceFilesError", () => {
    const err = new NoSourceFilesError("Empty dir");
    expect(err.message).toBe("Empty dir");
    expect(err.name).toBe("NoSourceFilesError");
  });

  it("creates ApiError", () => {
    const err = new ApiError("Failed API", 404);
    expect(err.message).toBe("Failed API");
    expect(err.statusCode).toBe(404);
  });

  it("creates AllBatchesFailedError", () => {
    const err = new AllBatchesFailedError("Network down");
    expect(err.message).toBe("Network down");
    expect(err.name).toBe("AllBatchesFailedError");
  });
});
