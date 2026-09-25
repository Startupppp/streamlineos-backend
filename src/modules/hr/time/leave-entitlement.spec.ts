import {
  hasNoLeavePolicy,
  openingEntitlementOf,
  resolveLeaveBalances,
} from "./leave-entitlement";

/**
 * HRMS-E2E-014. QA configured QA Casual Leave at 12 days a year and every
 * balance view still said "No leave policy is set up yet, so nothing has
 * accrued", with Available Days 0 — while the dashboard widget beside it read
 * 12 / 12 from the type's own `daysPerYear`.
 *
 * Both numbers were honestly derived; they just came from different places. The
 * balance read returned stored `leave_balances` rows, and a freshly configured
 * policy has none, because nothing creates a row until somebody consumes leave.
 * An organisation on its first day therefore looked identical to one with no
 * policy at all.
 *
 * These assertions pin the distinction the whole ticket turns on: **no types**
 * means no policy; **no rows** means nobody has taken leave yet.
 */
const CASUAL = { id: 1, name: "QA Casual Leave", daysPerYear: 12 };
const SICK = { id: 2, name: "Sick Leave", daysPerYear: 6 };
const UNPAID = { id: 3, name: "Leave Without Pay", daysPerYear: 0 };

describe("resolveLeaveBalances", () => {
  it("reports a configured type nobody has used yet at its full entitlement", () => {
    expect(resolveLeaveBalances([CASUAL], [])).toEqual([
      { leaveTypeId: 1, balance: "12.00", isOpeningEntitlement: true },
    ]);
  });

  it("lets a stored row win over the entitlement, so a deduction is visible", () => {
    // The paired positive from the other side. If the entitlement always won,
    // an approved leave would never appear to reduce anything — which is the
    // other half of what the audit could not verify.
    expect(resolveLeaveBalances([CASUAL], [{ leaveTypeId: 1, balance: "10.00" }])).toEqual([
      { leaveTypeId: 1, balance: "10.00", isOpeningEntitlement: false },
    ]);
  });

  it("keeps a stored zero rather than refilling it from the entitlement", () => {
    // A person who has spent the whole year's leave has balance 0 and a row.
    // Treating that as "no row, use the entitlement" would hand them 12 days back.
    expect(resolveLeaveBalances([CASUAL], [{ leaveTypeId: 1, balance: "0.00" }])).toEqual([
      { leaveTypeId: 1, balance: "0.00", isOpeningEntitlement: false },
    ]);
  });

  it("returns every configured type, mixing stored and opening balances", () => {
    const resolved = resolveLeaveBalances(
      [CASUAL, SICK, UNPAID],
      [{ leaveTypeId: 2, balance: "4.50" }],
    );

    expect(resolved).toEqual([
      { leaveTypeId: 1, balance: "12.00", isOpeningEntitlement: true },
      { leaveTypeId: 2, balance: "4.50", isOpeningEntitlement: false },
      { leaveTypeId: 3, balance: "0.00", isOpeningEntitlement: true },
    ]);
  });

  it("opens an unpaid type at nothing, because it grants nothing", () => {
    expect(openingEntitlementOf(UNPAID)).toBe("0.00");
  });

  it("ignores a stored row for a type the organisation no longer has", () => {
    // Types drive the output. A balance whose type was deleted is not a leave
    // anyone can take, and listing it would offer days against nothing.
    expect(resolveLeaveBalances([CASUAL], [{ leaveTypeId: 99, balance: "5.00" }])).toEqual([
      { leaveTypeId: 1, balance: "12.00", isOpeningEntitlement: true },
    ]);
  });

  it("returns nothing when the organisation has configured no types", () => {
    expect(resolveLeaveBalances([], [{ leaveTypeId: 1, balance: "12.00" }])).toEqual([]);
  });

  it("refuses to invent days from a negative or unreadable entitlement", () => {
    expect(openingEntitlementOf({ id: 9, name: "Broken", daysPerYear: -5 })).toBe("0.00");
    expect(openingEntitlementOf({ id: 9, name: "Broken", daysPerYear: Number.NaN })).toBe("0.00");
  });
});

describe("hasNoLeavePolicy", () => {
  it("is true only when no type is configured", () => {
    expect(hasNoLeavePolicy([])).toBe(true);
  });

  it("is false for a configured policy nobody has used yet", () => {
    // The sentence the audit reported. It was shown because zero *rows* was
    // read as zero *policies*; those are different facts and this is the line
    // between them.
    expect(hasNoLeavePolicy([CASUAL])).toBe(false);
  });
});
