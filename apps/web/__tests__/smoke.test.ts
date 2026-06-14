import { describe, it, expect } from "vitest";
import { MODELS } from "../lib/models";

describe("P0 smoke", () => {
  it("loads the canonical model config", () => {
    expect(MODELS.VISION).toContain("@cf/");
    expect(MODELS.REASONING).toContain("@cf/");
  });
});
