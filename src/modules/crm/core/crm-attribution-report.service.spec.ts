import { Test, TestingModule } from "@nestjs/testing";
import { CrmAttributionReportService } from "./crm-attribution-report.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { resolveLeadStatusSemantics } from "../../leads/lead-status-semantics";

const ORG = "org-test";

function makeInsertChain() {
  const chain = {
    values: jest.fn().mockResolvedValue(undefined),
  };
  return {
    insert: jest.fn().mockReturnValue(chain),
    _insertChain: chain,
  };
}

/**
 * A chainable stand-in for the query builder, resolving on `groupBy`.
 *
 * It mirrors the *shape* of the builder rather than the behaviour of the
 * database, so the only thing it can check is what `toAttribution` does with a
 * row it is handed — which is all the two cases below are for. Whether the SQL
 * underneath produces the right row is a question no mock can answer: the query
 * fans out or it does not, and a mock that never executes a join sees neither.
 * That half is pinned against a real database in
 * `test/crm/crm-attribution-fanout.seeded-e2e-spec.ts`.
 *
 * `groupBy` is both a terminal and a subquery step now — the report reduces the
 * touch log to one row per `(campaign, lead)` before joining any deal — so it
 * returns something that is awaitable *and* carries `.as()`.
 */
function fakeQueryBuilder(wonStages: { key: string }[], rows: unknown[]) {
  const alias: Record<string, unknown> = {};

  const chain: Record<string, unknown> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.groupBy = jest
    .fn()
    .mockImplementation(() =>
      Object.assign(Promise.resolve(rows), { as: jest.fn().mockReturnValue(alias) }),
    );

  // `resolveWonStageKeys` awaits `.where()` directly, with no `groupBy`.
  const wonStagesChain: Record<string, unknown> = {};
  wonStagesChain.from = jest.fn().mockReturnValue(wonStagesChain);
  wonStagesChain.where = jest.fn().mockResolvedValue(wonStages);

  let call = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? wonStagesChain : chain;
    }),
  };
}

describe("CrmAttributionReportService", () => {
  let svc: CrmAttributionReportService;

  describe("recordTouch", () => {
    let insertFn: jest.Mock;
    let valuesFn: jest.Mock;

    beforeEach(async () => {
      const insertChain = makeInsertChain();
      insertFn = insertChain.insert;
      valuesFn = insertChain._insertChain.values;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CrmAttributionReportService,
          { provide: DRIZZLE, useValue: insertChain },
        ],
      }).compile();

      svc = module.get(CrmAttributionReportService);
    });

    it("inserts a row with required fields and null defaults", async () => {
      const before = Date.now();
      await svc.recordTouch({
        orgId: ORG,
        leadId: 42,
        sourceKey: "google",
        touchType: "first_touch",
      });
      expect(insertFn).toHaveBeenCalledTimes(1);
      const [inserted] = valuesFn.mock.calls[0] as [Record<string, unknown>];
      expect(inserted.orgId).toBe(ORG);
      expect(inserted.leadId).toBe(42);
      expect(inserted.sourceKey).toBe("google");
      expect(inserted.touchType).toBe("first_touch");
      expect(inserted.medium).toBeNull();
      expect(inserted.utmData).toBeNull();
      expect(inserted.campaignId).toBeNull();
      expect((inserted.occurredAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it("passes through optional fields when provided", async () => {
      const ts = new Date("2024-01-15T10:00:00Z");
      await svc.recordTouch({
        orgId: ORG,
        leadId: 7,
        campaignId: 3,
        sourceKey: "email",
        medium: "newsletter",
        utmData: { utm_source: "email", utm_campaign: "q1" },
        touchType: "conversion",
        occurredAt: ts,
      });
      const [inserted] = valuesFn.mock.calls[0] as [Record<string, unknown>];
      expect(inserted.campaignId).toBe(3);
      expect(inserted.medium).toBe("newsletter");
      expect(inserted.utmData).toEqual({ utm_source: "email", utm_campaign: "q1" });
      expect(inserted.occurredAt).toBe(ts);
    });
  });

  describe("toAttribution math (via getFirstTouchAttribution)", () => {
    async function serviceOver(
      wonStages: { key: string }[],
      rows: unknown[],
    ): Promise<CrmAttributionReportService> {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CrmAttributionReportService,
          { provide: DRIZZLE, useValue: fakeQueryBuilder(wonStages, rows) },
        ],
      }).compile();
      return module.get(CrmAttributionReportService);
    }

    it("computes ROI as 0 when spend is 0", async () => {
      svc = await serviceOver([], [
        {
          campaignId: 1,
          campaignName: "Spring Sale",
          touchCount: 5,
          convertedLeads: 2,
          totalRevenue: 1000,
          spend: 0,
        },
      ]);

      const result = await svc.getFirstTouchAttribution(ORG);
      expect(result[0].roi).toBe(0);
      expect(result[0].dealRevenueCents).toBe(100000);
      expect(result[0].convertedLeads).toBe(2);
    });

    it("computes positive ROI correctly", async () => {
      svc = await serviceOver([{ key: "WON" }], [
        {
          campaignId: 2,
          campaignName: "Black Friday",
          touchCount: 10,
          convertedLeads: 4,
          totalRevenue: 3000,
          spend: 1000,
        },
      ]);

      const result = await svc.getFirstTouchAttribution(ORG);
      expect(result[0].roi).toBe(200);
      expect(result[0].dealRevenueCents).toBe(300000);
    });
  });

  /**
   * Both reports go through one aggregate now, so this is the same arithmetic
   * over a different set of touches — worth one case to say the last-touch entry
   * point reaches it, and no more. What the two rules actually select, and the
   * fan-out that made both of them overstate revenue, is measured against a real
   * database in `test/crm/crm-attribution-fanout.seeded-e2e-spec.ts`.
   */
  describe("getLastTouchAttribution", () => {
    it("returns the same shape through the shared aggregate", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CrmAttributionReportService,
          {
            provide: DRIZZLE,
            useValue: fakeQueryBuilder(
              [{ key: "WON" }],
              [
                {
                  campaignId: 3,
                  campaignName: "Webinar",
                  touchCount: 2,
                  convertedLeads: 1,
                  totalRevenue: 500,
                  spend: 250,
                },
              ],
            ),
          },
        ],
      }).compile();

      svc = module.get(CrmAttributionReportService);
      const result = await svc.getLastTouchAttribution(ORG);
      expect(result).toEqual([
        {
          campaignId: 3,
          campaignName: "Webinar",
          touchCount: 2,
          convertedLeads: 1,
          dealRevenueCents: 50000,
          roi: 100,
        },
      ]);
    });
  });
});

describe("resolveLeadStatusSemantics — pure function", () => {
  it("returns literal fallbacks when options array is empty (pre-seed org)", () => {
    const semantics = resolveLeadStatusSemantics([]);
    expect(semantics.convertedKeys).toEqual(["CONVERTED"]);
    expect(semantics.lostKeys).toEqual(["LOST"]);
    expect(semantics.activeKeys).toEqual(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"]);
    expect(semantics.slaOpenKeys).toEqual(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"]);
  });

  it("derives converted keys from terminal options without 'lost' semantic", () => {
    const options = [
      { key: "CLOSED_WON", isTerminal: true, metadata: { semantic: "won" } },
      { key: "CLOSED_LOST", isTerminal: true, metadata: { semantic: "lost" } },
      { key: "OPEN", isTerminal: false, metadata: null },
    ];
    const semantics = resolveLeadStatusSemantics(options);
    expect(semantics.convertedKeys).toEqual(["CLOSED_WON"]);
    expect(semantics.lostKeys).toEqual(["CLOSED_LOST"]);
    expect(semantics.activeKeys).toEqual(["OPEN"]);
    expect(semantics.slaOpenKeys).toEqual(["OPEN"]);
  });

  it("falls back to literal convertedKeys when no terminal non-lost option exists", () => {
    const options = [
      { key: "CLOSED_LOST", isTerminal: true, metadata: { semantic: "lost" } },
      { key: "OPEN", isTerminal: false, metadata: null },
    ];
    const semantics = resolveLeadStatusSemantics(options);
    expect(semantics.convertedKeys).toEqual(["CONVERTED"]);
    expect(semantics.lostKeys).toEqual(["CLOSED_LOST"]);
  });

  it("falls back to literal activeKeys when all options are terminal", () => {
    const options = [
      { key: "WON", isTerminal: true, metadata: null },
      { key: "LOST", isTerminal: true, metadata: { semantic: "lost" } },
    ];
    const semantics = resolveLeadStatusSemantics(options);
    expect(semantics.activeKeys).toEqual(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"]);
    expect(semantics.slaOpenKeys).toEqual(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"]);
  });
});
