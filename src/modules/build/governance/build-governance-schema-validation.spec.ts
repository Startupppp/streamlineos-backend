import {
  createRiskSchema,
  updateRiskSchema,
  createDecisionSchema,
  updateDecisionSchema,
} from "./dto/governance.schemas";

describe("createRiskSchema — whitespace-only title produces blank record until trim+min", () => {
  it("rejects whitespace-only title", () => {
    const result = createRiskSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a non-blank title after trimming", () => {
    const result = createRiskSchema.safeParse({ title: "API rate limit risk" });
    expect(result.success).toBe(true);
  });

  it("trims a title with surrounding whitespace before the min check", () => {
    const result = createRiskSchema.safeParse({ title: "  " });
    expect(result.success).toBe(false);
  });
});

describe("updateRiskSchema — whitespace-only title update produces blank record until trim+min", () => {
  it("rejects whitespace-only title on update", () => {
    const result = updateRiskSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a partial update that omits the title entirely", () => {
    const result = updateRiskSchema.safeParse({ description: "some detail" });
    expect(result.success).toBe(true);
  });
});

describe("createDecisionSchema — whitespace-only title produces blank record until trim+min", () => {
  it("rejects whitespace-only title", () => {
    const result = createDecisionSchema.safeParse({ title: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a non-blank title", () => {
    const result = createDecisionSchema.safeParse({ title: "Use shared auth" });
    expect(result.success).toBe(true);
  });
});

describe("createDecisionSchema — revisit date before decided date accepted until cross-field guard", () => {
  it("rejects revisitAt before decidedAt", () => {
    const result = createDecisionSchema.safeParse({
      title: "Use shared auth",
      decidedAt: "2026-06-01",
      revisitAt: "2026-01-01",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("revisitAt");
    }
  });

  it("accepts revisitAt equal to decidedAt", () => {
    const result = createDecisionSchema.safeParse({
      title: "Use shared auth",
      decidedAt: "2026-06-01",
      revisitAt: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("accepts revisitAt after decidedAt", () => {
    const result = createDecisionSchema.safeParse({
      title: "Use shared auth",
      decidedAt: "2026-01-01",
      revisitAt: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a decision with no dates at all", () => {
    const result = createDecisionSchema.safeParse({ title: "Use shared auth" });
    expect(result.success).toBe(true);
  });

  it("accepts a decision with only decidedAt and no revisitAt", () => {
    const result = createDecisionSchema.safeParse({
      title: "Use shared auth",
      decidedAt: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });
});

describe("updateDecisionSchema — revisit before decided accepted until cross-field guard", () => {
  it("rejects revisitAt before decidedAt on update", () => {
    const result = updateDecisionSchema.safeParse({
      decidedAt: "2026-06-01",
      revisitAt: "2026-01-01",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("revisitAt");
    }
  });

  it("accepts update that only clears revisitAt", () => {
    const result = updateDecisionSchema.safeParse({ revisitAt: null });
    expect(result.success).toBe(true);
  });
});
