import {
  createModuleSchema,
  updateModuleSchema,
  createSprintSchema,
  updateSprintSchema,
  createEpicSchema,
  updateEpicSchema,
} from "./dto/iterations.schemas";

describe("execution calendar date fields", () => {
  it("drops an empty-string start date instead of forwarding it to a postgres date column", () => {
    const parsed = createModuleSchema.parse({
      name: "Checkout",
      startDate: "",
      endDate: "",
    });

    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
  });

  it("keeps a real iso start date on the module create payload", () => {
    const parsed = createModuleSchema.parse({
      name: "Checkout",
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });

    expect(parsed.startDate).toBe("2026-10-01");
    expect(parsed.endDate).toBe("2026-10-31");
  });

  it("rejects a non-iso module date with a field message rather than a database error", () => {
    const result = createModuleSchema.safeParse({
      name: "Checkout",
      startDate: "01/10/2026",
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual(["startDate"]);
  });

  it("maps an empty-string module update date to null so the column is cleared, not corrupted", () => {
    const parsed = updateModuleSchema.parse({
      version: 1,
      startDate: "",
      endDate: "",
    });

    expect(parsed.startDate).toBeNull();
    expect(parsed.endDate).toBeNull();
  });

  it("leaves an omitted module update date untouched", () => {
    const parsed = updateModuleSchema.parse({ version: 1 });

    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
  });

  it("refuses an empty-string sprint date because both sprint dates are required", () => {
    const result = createSprintSchema.safeParse({
      name: "Sprint 01",
      startDate: "",
      endDate: "",
    });

    expect(result.success).toBe(false);
  });

  it("accepts an iso sprint date range", () => {
    const parsed = createSprintSchema.parse({
      name: "Sprint 01",
      startDate: "2026-10-01",
      endDate: "2026-10-14",
    });

    expect(parsed.startDate).toBe("2026-10-01");
  });

  it("drops empty-string sprint update dates", () => {
    const parsed = updateSprintSchema.parse({ startDate: "", endDate: "" });

    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
  });

  it("drops an empty-string epic due date", () => {
    const parsed = createEpicSchema.parse({
      title: "Payments",
      startDate: "",
      dueDate: "",
    });

    expect(parsed.startDate).toBeUndefined();
    expect(parsed.dueDate).toBeUndefined();
  });

  it("maps an empty-string epic update due date to null", () => {
    const parsed = updateEpicSchema.parse({ version: 1, dueDate: "" });

    expect(parsed.dueDate).toBeNull();
  });
});
