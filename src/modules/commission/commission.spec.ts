import {
  assertPlanIsUsable,
  CommissionPlanError,
  retroactiveVersions,
  ruleFor,
  versionInForceAt,
  type CommissionPlan,
} from "./commission-plan";
import {
  accrueForDeal,
  decomposeForPerson,
  payoutMinor,
  type AccrualEntry,
  type DealForAccrual,
} from "./commission-accrual";
import { applyClawback, clawbackFor, CommissionClawbackError } from "./commission-clawback";

const d = (iso: string) => new Date(iso);
const id = (deal: string, person: string) => `${deal}:${person}`;

/** March: 10%. July: 15%. A payout must use the one in force when it was earned. */
const PLAN: CommissionPlan = {
  planId: "plan-1",
  organizationId: "org-1",
  name: "Standard",
  versions: [
    {
      version: 1,
      effectiveFrom: d("2026-03-01T00:00:00.000Z"),
      createdAt: d("2026-03-01T00:00:00.000Z"),
      rules: [{ whenStage: "WON", rateBps: 1_000 }],
    },
    {
      version: 2,
      effectiveFrom: d("2026-07-01T00:00:00.000Z"),
      createdAt: d("2026-07-01T00:00:00.000Z"),
      rules: [{ whenStage: "WON", rateBps: 1_500 }],
    },
  ],
};

function deal(over: Partial<DealForAccrual> = {}): DealForAccrual {
  return {
    dealId: "deal-1",
    organizationId: "org-1",
    stage: "WON",
    valueMinor: 1_000_000,
    occurredAt: d("2026-04-15T00:00:00.000Z"),
    splits: [{ personId: "rep-a", splitBps: 10_000 }],
    ...over,
  };
}

describe("a payout reproduces from the plan in force when it was earned", () => {
  it("uses March's 10% for an April deal, even in December", () => {
    const entries = accrueForDeal(deal(), PLAN, id);
    expect(entries[0]!.planVersion).toBe(1);
    expect(entries[0]!.rateBps).toBe(1_000);
    // 1_000_000 minor units at 10%.
    expect(payoutMinor(entries)).toBe(100_000);
  });

  it("uses July's 15% for an August deal", () => {
    const entries = accrueForDeal(deal({ occurredAt: d("2026-08-01T00:00:00.000Z") }), PLAN, id);
    expect(entries[0]!.planVersion).toBe(2);
    expect(payoutMinor(entries)).toBe(150_000);
  });

  it("earns nothing before any version existed, rather than inventing an obligation", () => {
    expect(versionInForceAt(PLAN, d("2026-01-01T00:00:00.000Z"))).toBeNull();
    expect(accrueForDeal(deal({ occurredAt: d("2026-01-01T00:00:00.000Z") }), PLAN, id)).toEqual([]);
  });

  it("takes a version effective at the exact instant of the deal", () => {
    const entries = accrueForDeal(deal({ occurredAt: d("2026-07-01T00:00:00.000Z") }), PLAN, id);
    expect(entries[0]!.planVersion).toBe(2);
  });

  it("records a retroactive version rather than applying it silently", () => {
    const retro: CommissionPlan = {
      ...PLAN,
      versions: [
        ...PLAN.versions,
        {
          version: 3,
          effectiveFrom: d("2026-05-01T00:00:00.000Z"),
          createdAt: d("2026-09-01T00:00:00.000Z"),
          retroactiveReason: "board approved a mid-year uplift",
          rules: [{ whenStage: "WON", rateBps: 1_200 }],
        },
      ],
    };

    const listed = retroactiveVersions(retro);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.retroactiveReason).toBe("board approved a mid-year uplift");
    // And it does take effect for a deal in its window.
    expect(accrueForDeal(deal({ occurredAt: d("2026-06-01T00:00:00.000Z") }), retro, id)[0]!.rateBps)
      .toBe(1_200);
  });
});

describe("tiers and thresholds", () => {
  const tiered: CommissionPlan = {
    ...PLAN,
    versions: [
      {
        version: 1,
        effectiveFrom: d("2026-01-01T00:00:00.000Z"),
        createdAt: d("2026-01-01T00:00:00.000Z"),
        rules: [
          { whenStage: "WON", rateBps: 500 },
          { whenStage: "WON", rateBps: 1_000, minimumDealValueMinor: 500_000 },
        ],
      },
    ],
  };

  it("takes the highest minimum the deal clears", () => {
    expect(ruleFor(tiered.versions[0]!, "WON", 600_000)!.rateBps).toBe(1_000);
    expect(ruleFor(tiered.versions[0]!, "WON", 100_000)!.rateBps).toBe(500);
  });

  it("earns nothing at a stage no rule names, which is not an error", () => {
    expect(accrueForDeal(deal({ stage: "PROPOSAL" }), PLAN, id)).toEqual([]);
  });
});

/*
  Ticket 05 asks specifically for "a percentage of a percentage where rounding
  drift appears". These are that case.
*/
describe("rounding happens once, over the whole set", () => {
  it("splits a deal three ways without losing a minor unit", () => {
    // 10% of 1_000_001 = 100_000.1, split three ways at 3333/3333/3334 bps.
    // Rounded per entry this loses units; rounded once it does not.
    const entries = accrueForDeal(
      deal({
        valueMinor: 1_000_001,
        splits: [
          { personId: "a", splitBps: 3_333 },
          { personId: "b", splitBps: 3_333 },
          { personId: "c", splitBps: 3_334 },
        ],
      }),
      PLAN,
      id,
    );

    // The whole set rounds to the commission on the whole deal.
    expect(payoutMinor(entries)).toBe(100_000);
  });

  it("keeps a 40% split of a 15% commission exact until payout", () => {
    const august = deal({
      occurredAt: d("2026-08-01T00:00:00.000Z"),
      valueMinor: 333_333,
      splits: [
        { personId: "a", splitBps: 4_000 },
        { personId: "b", splitBps: 6_000 },
      ],
    });
    const entries = accrueForDeal(august, PLAN, id);

    // 333_333 x 15% = 49_999.95 -> 50_000 for the pair.
    expect(payoutMinor(entries)).toBe(50_000);
    // a: 49_999.95 x 40% = 19_999.98 -> 20_000
    expect(payoutMinor(entries.filter((e) => e.personId === "a"))).toBe(20_000);
  });

  it("differs from per-entry rounding, which is the whole reason for the rule", () => {
    /*
      Not a stylistic preference. A twelve-and-a-half per cent commission on
      1_000_001 minor units, split six ways, rounds to 125_000 once and to
      125_002 if each entry is rounded as it is written — the company overpays two
      minor units on every such deal, and nobody can reconstruct why.

      There are 1_542 such cases in the first two hundred deal values alone. This
      pins one so that a future change to per-entry rounding fails here rather
      than in a reconciliation.
    */
    const sixWay: CommissionPlan = {
      ...PLAN,
      versions: [
        {
          version: 1,
          effectiveFrom: d("2026-01-01T00:00:00.000Z"),
          createdAt: d("2026-01-01T00:00:00.000Z"),
          rules: [{ whenStage: "WON", rateBps: 1_250 }],
        },
      ],
    };
    const entries = accrueForDeal(
      deal({
        valueMinor: 1_000_001,
        occurredAt: d("2026-06-01T00:00:00.000Z"),
        splits: [
          { personId: "a", splitBps: 1_667 },
          { personId: "b", splitBps: 1_666 },
          { personId: "c", splitBps: 1_667 },
          { personId: "d", splitBps: 1_667 },
          { personId: "e", splitBps: 1_666 },
          { personId: "f", splitBps: 1_667 },
        ],
      }),
      sixWay,
      id,
    );

    expect(payoutMinor(entries)).toBe(125_000);

    // What the same ledger would have paid with per-entry rounding.
    const perEntry = entries.reduce(
      (total, e) => total + Math.round((e.basisMinor * e.rateBps * e.splitBps) / (10_000 * 10_000)),
      0,
    );
    expect(perEntry).toBe(125_002);
  });

  it("stores the inputs rather than the answer, so the working can be shown", () => {
    const entry = accrueForDeal(deal(), PLAN, id)[0]!;
    expect(entry.basisMinor).toBe(1_000_000);
    expect(entry.rateBps).toBe(1_000);
    expect(entry.splitBps).toBe(10_000);
    expect(entry).not.toHaveProperty("amountMinor");
  });

  it("refuses splits that do not add up, rather than paying out a fraction of a deal", () => {
    expect(() =>
      accrueForDeal(deal({ splits: [{ personId: "a", splitBps: 5_000 }] }), PLAN, id),
    ).toThrow(/total 5000 basis points/);
  });
});

describe("a figure decomposes to the deals that produced it", () => {
  it("shows a rep their own lines and their total", () => {
    const entries = [
      ...accrueForDeal(deal({ dealId: "d1", valueMinor: 500_000 }), PLAN, id),
      ...accrueForDeal(deal({ dealId: "d2", valueMinor: 250_000 }), PLAN, id),
      ...accrueForDeal(
        deal({ dealId: "d3", valueMinor: 900_000, splits: [{ personId: "rep-b", splitBps: 10_000 }] }),
        PLAN,
        id,
      ),
    ];

    const mine = decomposeForPerson(entries, "rep-a");
    expect(mine.lines.map((line) => line.dealId)).toEqual(["d1", "d2"]);
    expect(mine.payoutMinor).toBe(75_000);
    // Somebody else's deal is not in my decomposition.
    expect(mine.lines.some((line) => line.dealId === "d3")).toBe(false);
  });
});

describe("a reversal claws back through the same ledger", () => {
  const earned = accrueForDeal(deal({ dealId: "d1" }), PLAN, id);

  it("writes an entry rather than editing the original", () => {
    const claw = clawbackFor({
      original: earned[0]!,
      reason: "customer cancelled within the refund window",
      occurredAt: d("2026-05-01T00:00:00.000Z"),
      entryId: "claw-1",
    });

    expect(claw.reason).toBe("clawback");
    expect(claw.reversesEntryId).toBe(earned[0]!.entryId);
    // Same basis and rate as the original, not today's plan.
    expect(claw.rateBps).toBe(earned[0]!.rateBps);
    // The original is untouched.
    expect(earned[0]!.reason).toBe("earned");
  });

  it("nets to nothing when a deal is fully reversed", () => {
    const claw = clawbackFor({
      original: earned[0]!, reason: "cancelled", occurredAt: d("2026-05-01T00:00:00.000Z"), entryId: "c1",
    });
    expect(payoutMinor([...earned, claw])).toBe(0);
  });

  it("refuses to claw back a clawback", () => {
    const claw = clawbackFor({
      original: earned[0]!, reason: "cancelled", occurredAt: d("2026-05-01T00:00:00.000Z"), entryId: "c1",
    });
    expect(() =>
      clawbackFor({ original: claw, reason: "again", occurredAt: d("2026-06-01T00:00:00.000Z"), entryId: "c2" }),
    ).toThrow(CommissionClawbackError);
  });

  it("refuses a clawback with no reason, since the record is the point", () => {
    expect(() =>
      clawbackFor({ original: earned[0]!, reason: "   ", occurredAt: d("2026-05-01T00:00:00.000Z"), entryId: "c1" }),
    ).toThrow(/must carry a reason/);
  });

  it("carries a negative balance forward under that policy", () => {
    const big = accrueForDeal(deal({ dealId: "d9", valueMinor: 2_000_000 }), PLAN, id);
    const claw = clawbackFor({
      original: big[0]!, reason: "reclassified", occurredAt: d("2026-05-01T00:00:00.000Z"), entryId: "c9",
    });

    // Ledger holds only the smaller deal, so reversing the big one goes under.
    const { notice } = applyClawback(earned, claw, "carry-forward");
    expect(notice.balanceAfterMinor).toBeLessThan(0);
    expect(notice.carriedForwardMinor).toBeGreaterThan(0);
    expect(notice.reason).toBe("reclassified");
    expect(notice.dealId).toBe("d9");
  });

  it("floors at zero under that policy, and reports what was not recovered", () => {
    const big = accrueForDeal(deal({ dealId: "d9", valueMinor: 2_000_000 }), PLAN, id);
    const claw = clawbackFor({
      original: big[0]!, reason: "reclassified", occurredAt: d("2026-05-01T00:00:00.000Z"), entryId: "c9",
    });

    const { entries, notice } = applyClawback(earned, claw, "floor-at-zero");
    expect(notice.balanceAfterMinor).toBe(0);
    expect(notice.carriedForwardMinor).toBe(100_000);
    // Recorded either way: the criterion is that it is never a silent recalculation.
    expect(entries).toContain(claw);
  });
});

describe("a plan that cannot be paid from is refused when it is saved", () => {
  it("refuses a rate outside nought to a hundred per cent", () => {
    const bad: CommissionPlan = {
      ...PLAN,
      versions: [{ ...PLAN.versions[0]!, rules: [{ whenStage: "WON", rateBps: 10_001 }] }],
    };
    expect(() => assertPlanIsUsable(bad)).toThrow(CommissionPlanError);
  });

  it("refuses two versions with the same number", () => {
    const bad: CommissionPlan = { ...PLAN, versions: [PLAN.versions[0]!, PLAN.versions[0]!] };
    expect(() => assertPlanIsUsable(bad)).toThrow(/two versions numbered/);
  });

  it("accepts the worked plan", () => {
    expect(() => assertPlanIsUsable(PLAN)).not.toThrow();
  });
});
