import { titleSchema } from "./calendar.schemas";

describe("calendar titleSchema", () => {
  it("stores the trimmed value", () => {
    expect(titleSchema.parse("  Standup  ")).toBe("Standup");
    expect(titleSchema.parse("\tQ3 review\n")).toBe("Q3 review");
  });

  it("applies min(2) to the trimmed length", () => {
    expect(titleSchema.safeParse(" a ").success).toBe(false);
    expect(titleSchema.safeParse("          ").success).toBe(false);
    expect(titleSchema.safeParse(" ab ").success).toBe(true);
  });

  it("applies max(100) to the trimmed length", () => {
    const hundred = "a".repeat(100);
    expect(titleSchema.parse(`  ${hundred}  `)).toBe(hundred);
    expect(titleSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("still rejects a title with no letter or number", () => {
    expect(titleSchema.safeParse("---").success).toBe(false);
  });

  it("still rejects consecutive inner spaces", () => {
    expect(titleSchema.safeParse("Team  sync").success).toBe(false);
  });
});
