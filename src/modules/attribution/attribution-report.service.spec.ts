import { Test, type TestingModule } from "@nestjs/testing";
import {
  activities,
  crmCampaigns,
  crmLeadTouchpoints,
  crmPipelineStages,
  deals,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import {
  AttributionError,
  allocateExact,
  attributeDeal,
} from "./attribution-allocate";
import { ATTRIBUTION_MODELS, type AttributionModel } from "./attribution-models";
import type { AttributionTouch } from "./attribution-touch";
import {
  AttributionReportService,
  type AttributionReport,
} from "./attribution-report.service";

const ORG = "org-attribution";

/**
 * The invariant this whole module exists to hold: a deal is divided, never
 * approximated. Every model, every touch count, every awkward total.
 */
function expectSumsExactly(shares: readonly number[], total: number): void {
  expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
  expect(shares.every((s) => Number.isSafeInteger(s))).toBe(true);
}

describe("allocateExact", () => {
  it("hands the leftover unit to the largest remainder, deterministically", () => {
    // 100 / 3 leaves one unit over; the three remainders tie, so the tie-break
    // is the slot index and the same call twice must give the same answer.
    expect(allocateExact(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateExact(100, [1, 1, 1])).toEqual(allocateExact(100, [1, 1, 1]));
  });

  it("gives a zero-weight slot nothing and still ties", () => {
    expect(allocateExact(100003, [1, 0, 0])).toEqual([100003, 0, 0]);
    expect(allocateExact(100003, [0, 0, 1])).toEqual([0, 0, 100003]);
  });

  it("sums exactly for awkward totals against awkward weights", () => {
    const totals = [0, 1, 7, 99, 100003, 999_999_937, 12_345_678_901];
    const weightSets = [
      [1],
      [1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [40, 20, 40],
      [80, 20, 20, 80],
      [1_000_000, 707_107, 500_000, 353_553, 1],
      [1, 0, 0, 0, 999_999],
    ];
    for (const total of totals) {
      for (const weights of weightSets) {
        expectSumsExactly(allocateExact(total, weights), total);
      }
    }
  });

  it("reverses a negative deal along the same timeline and still ties", () => {
    // A credited deal is a real row; the leftover moves the other way.
    expectSumsExactly(allocateExact(-100003, [40, 20, 40]), -100003);
    expect(allocateExact(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  it("refuses the inputs weightsFor can never produce", () => {
    expect(() => allocateExact(100, [])).toThrow(AttributionError);
    expect(() => allocateExact(100, [0, 0])).toThrow(AttributionError);
    expect(() => allocateExact(100, [1, -1])).toThrow(AttributionError);
    expect(() => allocateExact(100, [1, 1.5])).toThrow(AttributionError);
    expect(() => allocateExact(1.5, [1])).toThrow(AttributionError);
  });
});

describe("attributeDeal", () => {
  const closedAt = new Date("2026-08-15T12:00:00Z");

  function touchAt(key: string, iso: string, campaignId: number | null): AttributionTouch {
    return {
      touchKey: key,
      touchKind: "touchpoint",
      channel: "email",
      campaignId,
      occurredAt: new Date(iso),
      detail: "interaction",
    };
  }

  const timeline = [
    touchAt("touchpoint:1", "2026-06-01T00:00:00Z", 1),
    touchAt("touchpoint:2", "2026-07-01T00:00:00Z", 2),
    touchAt("touchpoint:3", "2026-08-01T00:00:00Z", 3),
    touchAt("touchpoint:4", "2026-08-14T00:00:00Z", 4),
    touchAt("touchpoint:5", "2026-08-15T00:00:00Z", 5),
  ];

  it.each(ATTRIBUTION_MODELS)(
    "%s divides the deal exactly — no lost or invented minor unit",
    (model: AttributionModel) => {
      // A prime revenue against every touch count from 1 to 5, so no model gets
      // a clean division anywhere.
      const revenueMinor = 1_000_003;
      for (let n = 1; n <= timeline.length; n += 1) {
        const allocations = attributeDeal(
          model,
          { revenueMinor, closedAt },
          timeline.slice(0, n),
        );
        expect(allocations).toHaveLength(n);
        expectSumsExactly(
          allocations.map((a) => a.revenueMinor),
          revenueMinor,
        );
      }
    },
  );

  it("linear splits evenly and puts the odd unit on the first touch", () => {
    const allocations = attributeDeal(
      "linear",
      { revenueMinor: 100_003, closedAt },
      timeline.slice(0, 3),
    );
    expect(allocations.map((a) => a.revenueMinor)).toEqual([33_335, 33_334, 33_334]);
    expectSumsExactly(allocations.map((a) => a.revenueMinor), 100_003);
  });

  it("position_based holds 40 / 20 / 40 and still ties", () => {
    const allocations = attributeDeal(
      "position_based",
      { revenueMinor: 100_003, closedAt },
      timeline.slice(0, 3),
    );
    expect(allocations.map((a) => a.weight)).toEqual([40, 20, 40]);
    expect(allocations.map((a) => a.revenueMinor)).toEqual([40_001, 20_001, 40_001]);
    expectSumsExactly(allocations.map((a) => a.revenueMinor), 100_003);
  });

  it("time_decay leans on the touches nearest the close and still ties", () => {
    const allocations = attributeDeal(
      "time_decay",
      { revenueMinor: 1_000_003, closedAt },
      timeline,
      7,
    );
    const shares = allocations.map((a) => a.revenueMinor);
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]).toBeGreaterThan(shares[i - 1]);
    }
    expectSumsExactly(shares, 1_000_003);
  });

  it("a shorter half-life concentrates credit without changing the total", () => {
    const slow = attributeDeal(
      "time_decay",
      { revenueMinor: 1_000_003, closedAt },
      timeline,
      365,
    );
    const fast = attributeDeal(
      "time_decay",
      { revenueMinor: 1_000_003, closedAt },
      timeline,
      1,
    );
    expect(fast[fast.length - 1].revenueMinor).toBeGreaterThan(
      slow[slow.length - 1].revenueMinor,
    );
    expectSumsExactly(fast.map((a) => a.revenueMinor), 1_000_003);
    expectSumsExactly(slow.map((a) => a.revenueMinor), 1_000_003);
  });

  it("refuses an empty touch set rather than returning an empty allocation", () => {
    expect(() =>
      attributeDeal("linear", { revenueMinor: 100, closedAt }, []),
    ).toThrow(AttributionError);
  });
});

/**
 * A Drizzle stand-in that answers by TABLE rather than by call order.
 *
 * The service issues five reads whose order is an implementation detail (two of
 * them run under one `Promise.all`), so a mock keyed on call count asserts the
 * order rather than the behaviour and breaks on any reshuffle. Dispatching on
 * the object handed to `.from()` survives that.
 */
interface FakeQuery {
  from(table: unknown): FakeQuery;
  where(): FakeQuery;
  orderBy(): FakeQuery;
  limit(): FakeQuery;
  then<T>(
    resolve: (rows: unknown[]) => T,
    reject: (reason: unknown) => T,
  ): Promise<T>;
}

function makeDb(fixtures: {
  stages: unknown[];
  wonDeals: unknown[];
  touchpoints: unknown[];
  salesActivities: unknown[];
  campaigns: unknown[];
}) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === crmPipelineStages) return fixtures.stages;
    if (table === deals) return fixtures.wonDeals;
    if (table === crmLeadTouchpoints) return fixtures.touchpoints;
    if (table === activities) return fixtures.salesActivities;
    if (table === crmCampaigns) return fixtures.campaigns;
    throw new Error("Unexpected table read in AttributionReportService");
  };

  return {
    select: (): FakeQuery => {
      let table: unknown = null;
      const chain: FakeQuery = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        // Thenable, so the same object serves both `await db.select()…where()`
        // and the deal read's `.where().orderBy().limit()`.
        then: (resolve, reject) =>
          Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return chain;
    },
  };
}

describe("AttributionReportService", () => {
  const CLOSE_DAY = "2026-08-15";

  const fixtures = {
    stages: [{ key: "WON" }],
    wonDeals: [
      // Three touches on the timeline, one of them a sales activity logged the
      // morning of the close.
      {
        dealId: 1,
        leadId: 10,
        valueMinor: 100_003,
        actualCloseDate: CLOSE_DAY,
        updatedAt: new Date("2026-08-16T00:00:00Z"),
      },
      // No close date: the clock falls back to `updated_at`.
      {
        dealId: 2,
        leadId: 11,
        valueMinor: 50_000,
        actualCloseDate: null,
        updatedAt: new Date("2026-08-20T00:00:00Z"),
      },
      // Won, with nothing on its timeline at all.
      {
        dealId: 3,
        leadId: null,
        valueMinor: 7_777,
        actualCloseDate: "2026-08-01",
        updatedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ],
    touchpoints: [
      {
        id: "a",
        leadId: 10,
        campaignId: 101,
        sourceKey: "Google Ads",
        touchType: "first_touch",
        occurredAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: "b",
        leadId: 10,
        campaignId: 102,
        sourceKey: "email",
        touchType: "interaction",
        occurredAt: new Date("2026-08-10T00:00:00Z"),
      },
      {
        id: "c",
        leadId: 11,
        campaignId: 101,
        sourceKey: "  EMAIL  ",
        touchType: "first_touch",
        occurredAt: new Date("2026-08-05T00:00:00Z"),
      },
    ],
    salesActivities: [
      {
        activityId: "x",
        dealId: 1,
        kind: "call",
        subject: "Demo",
        occurredAt: new Date("2026-08-15T10:00:00Z"),
      },
      // Logged after the close — the onboarding mail the module exists to stop
      // stealing credit from the campaign that created the deal.
      {
        activityId: "y",
        dealId: 1,
        kind: "email",
        subject: null,
        occurredAt: new Date("2026-08-20T00:00:00Z"),
      },
      {
        activityId: "z",
        dealId: 2,
        kind: "meeting",
        subject: "Kickoff",
        occurredAt: new Date("2026-08-25T00:00:00Z"),
      },
    ],
    campaigns: [
      { id: 101, name: "Spring Sale", deletedAt: null },
      { id: 102, name: "Nurture", deletedAt: new Date("2026-09-01T00:00:00Z") },
    ],
  };

  const TOTAL_REVENUE = 100_003 + 50_000 + 7_777;
  const ATTRIBUTABLE_REVENUE = 100_003 + 50_000;

  async function report(
    model: AttributionModel,
    halfLifeDays = 7,
  ): Promise<AttributionReport> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttributionReportService,
        { provide: DRIZZLE, useValue: makeDb(fixtures) },
      ],
    }).compile();
    return module.get(AttributionReportService).getReport(ORG, model, halfLifeDays);
  }

  it.each(ATTRIBUTION_MODELS)(
    "%s: every minor unit lands in exactly one campaign bucket",
    async (model: AttributionModel) => {
      const result = await report(model);

      expect(result.totalRevenueMinor).toBe(TOTAL_REVENUE);
      expect(result.attributedRevenueMinor).toBe(ATTRIBUTABLE_REVENUE);
      // The unattributable half is the deal with no timeline, reported rather
      // than folded into a channel nobody bought.
      expect(result.unattributableRevenueMinor).toBe(7_777);
      expect(
        result.attributedRevenueMinor + result.unattributableRevenueMinor,
      ).toBe(result.totalRevenueMinor);

      const byCampaign = result.campaigns.reduce(
        (sum, c) => sum + c.attributedRevenueMinor,
        0,
      );
      const byChannel = result.channels.reduce(
        (sum, c) => sum + c.attributedRevenueMinor,
        0,
      );
      expect(byCampaign).toBe(ATTRIBUTABLE_REVENUE);
      expect(byChannel).toBe(ATTRIBUTABLE_REVENUE);
    },
  );

  it("counts the deal with no touches instead of dropping it", async () => {
    const result = await report("linear");
    expect(result.dealsConsidered).toBe(3);
    expect(result.dealsAttributed).toBe(2);
    expect(result.dealsWithoutTouches).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("linear divides deal 1 three ways and gives deal 2 to its only touch", async () => {
    const result = await report("linear");
    const spring = result.campaigns.find((c) => c.campaignId === 101);
    const nurture = result.campaigns.find((c) => c.campaignId === 102);
    const direct = result.campaigns.find((c) => c.campaignId === null);

    // Deal 1: 100003 / 3 = 33334 each with one unit over, which goes to the
    // first touch. Deal 2's single touch takes all 50000.
    expect(spring?.attributedRevenueMinor).toBe(33_335 + 50_000);
    expect(nurture?.attributedRevenueMinor).toBe(33_334);
    expect(direct?.attributedRevenueMinor).toBe(33_334);
    expect(spring?.dealCount).toBe(2);
    expect(direct?.dealCount).toBe(1);
  });

  it("position_based holds 40 / 20 / 40 across the real timeline", async () => {
    const result = await report("position_based");
    const spring = result.campaigns.find((c) => c.campaignId === 101);
    const nurture = result.campaigns.find((c) => c.campaignId === 102);
    const direct = result.campaigns.find((c) => c.campaignId === null);

    expect(spring?.attributedRevenueMinor).toBe(40_001 + 50_000);
    expect(nurture?.attributedRevenueMinor).toBe(20_001);
    expect(direct?.attributedRevenueMinor).toBe(40_001);
  });

  it("time_decay leans towards the close without losing a unit", async () => {
    const result = await report("time_decay", 7);
    const spring = result.campaigns.find((c) => c.campaignId === 101);
    const nurture = result.campaigns.find((c) => c.campaignId === 102);
    const direct = result.campaigns.find((c) => c.campaignId === null);

    // The sales call is the last touch before the close, the nurture mail is
    // five days earlier, the first touch a fortnight before that.
    expect(direct?.attributedRevenueMinor).toBeGreaterThan(
      nurture?.attributedRevenueMinor ?? 0,
    );
    // Spring carries deal 2 whole, so compare only its share of deal 1.
    expect((spring?.attributedRevenueMinor ?? 0) - 50_000).toBeLessThan(
      nurture?.attributedRevenueMinor ?? 0,
    );
    expect(result.halfLifeDays).toBe(7);
  });

  it("first_touch and last_touch put the whole deal on one campaign", async () => {
    const first = await report("first_touch");
    const last = await report("last_touch");

    // Deal 1's first touch is Spring, deal 2's only touch is Spring too.
    expect(first.campaigns.find((c) => c.campaignId === 101)?.attributedRevenueMinor)
      .toBe(100_003 + 50_000);
    expect(first.campaigns.find((c) => c.campaignId === 102)?.attributedRevenueMinor)
      .toBe(0);

    // Deal 1's last ELIGIBLE touch is the sales call on the day of the close —
    // not the follow-up mail sent five days after it.
    expect(last.campaigns.find((c) => c.campaignId === null)?.attributedRevenueMinor)
      .toBe(100_003);
    expect(last.campaigns.find((c) => c.campaignId === 101)?.attributedRevenueMinor)
      .toBe(50_000);
  });

  it("normalises channel spellings into one row", async () => {
    const result = await report("linear");
    const email = result.channels.filter((c) => c.channel === "email");
    expect(email).toHaveLength(1);
    // `email` (deal 1's nurture touch) and `  EMAIL  ` (deal 2's) are one
    // channel, so the roll-up counts two touches under it.
    expect(email[0].touchCount).toBe(2);
    expect(result.channels.map((c) => c.channel).sort()).toEqual([
      "email",
      "google ads",
      "sales_call",
    ]);
  });

  it("names a soft-deleted campaign and says it is archived", async () => {
    const result = await report("linear");
    const nurture = result.campaigns.find((c) => c.campaignId === 102);
    expect(nurture?.campaignName).toBe("Nurture");
    expect(nurture?.campaignArchived).toBe(true);
    expect(
      result.campaigns.find((c) => c.campaignId === 101)?.campaignArchived,
    ).toBe(false);
  });

  it("echoes the model and its description so a saved report is readable", async () => {
    const result = await report("time_decay", 30);
    expect(result.model).toBe("time_decay");
    expect(result.modelDescription).toContain("half-life");
    expect(result.halfLifeDays).toBe(30);
  });
});
