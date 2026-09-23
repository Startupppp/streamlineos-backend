import { createLeavePolicySchema } from "../dto/leaves.schemas";

const BASE = {
  leaveTypeId: 1,
  name: "QA Audit Leave Policy",
  accrualType: "ANNUAL",
  accrualRate: "2",
  carryForwardDays: "0",
  encashable: false,
  probationRestricted: false,
  effectiveFrom: "2026-09-23",
};

describe("leave policy creation refuses at the boundary what the numeric column cannot store, instead of reaching Postgres and returning 500 Something went wrong", () => {
  it("drops a blank max balance rather than sending an empty string to a numeric column", () => {
    const parsed = createLeavePolicySchema.safeParse({ ...BASE, maxBalance: "" });

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.maxBalance).toBeUndefined();
    expect("maxBalance" in (parsed.data ?? {})).toBe(true);
  });

  it("drops a blank carry-forward the same way", () => {
    const parsed = createLeavePolicySchema.safeParse({
      ...BASE,
      carryForwardDays: "   ",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.carryForwardDays).toBeUndefined();
  });

  it("accepts the shape the policy sheet actually submits", () => {
    const parsed = createLeavePolicySchema.safeParse({
      ...BASE,
      maxBalance: "",
      leaveTypeId: 7,
    });

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.accrualRate).toBe("2");
  });

  it.each([
    ["abc", "a non-numeric accrual rate"],
    ["2,5", "a comma decimal separator"],
    ["-1", "a negative number of days"],
  ])("refuses %s (%s) with a field-level message, not a database error", (accrualRate) => {
    const parsed = createLeavePolicySchema.safeParse({ ...BASE, accrualRate });

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    expect(issue?.path).toEqual(["accrualRate"]);
    expect(issue?.message).toBe(
      "Accrual rate must be a number of days, like 2 or 1.5",
    );
  });

  it("names the empty accrual rate as required rather than as a bad number", () => {
    const parsed = createLeavePolicySchema.safeParse({ ...BASE, accrualRate: "" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Accrual rate is required");
  });

  it("refuses a max balance that is not a number", () => {
    const parsed = createLeavePolicySchema.safeParse({
      ...BASE,
      maxBalance: "lots",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["maxBalance"]);
  });

  it("keeps the same guarantees on update, which derives from the create schema", () => {
    const { updateLeavePolicySchema } = jest.requireActual<
      typeof import("../dto/leaves.schemas")
    >("../dto/leaves.schemas");

    const parsed = updateLeavePolicySchema.safeParse({ maxBalance: "" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.maxBalance).toBeUndefined();
  });
});
