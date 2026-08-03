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

function _makeSelectChain(resolveWith: unknown[]) {
  const chain: Record<string, unknown> = {};
  const terminal = jest.fn().mockResolvedValue(resolveWith);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.groupBy = jest.fn().mockResolvedValue(resolveWith);
  chain.as = jest.fn().mockReturnValue(chain);
  chain._terminal = terminal;
  return chain;
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
    it("computes ROI as 0 when spend is 0", async () => {
      const rows = [
        {
          campaignId: 1,
          campaignName: "Spring Sale",
          touchCount: 5,
          convertedLeads: 2,
          totalRevenue: 1000,
          spend: 0,
        },
      ];

      const db: Record<string, unknown> = {};
      db.select = jest.fn().mockReturnValue(db);
      db.from = jest.fn().mockReturnValue(db);
      db.leftJoin = jest.fn().mockReturnValue(db);
      db.where = jest.fn().mockReturnValue(db);
      db.groupBy = jest.fn().mockResolvedValue(rows);
      db.select = jest.fn().mockReturnValue(db);
      const wonStagesChain: Record<string, unknown> = {};
      wonStagesChain.select = jest.fn().mockReturnValue(wonStagesChain);
      wonStagesChain.from = jest.fn().mockReturnValue(wonStagesChain);
      wonStagesChain.where = jest.fn().mockResolvedValue([]);

      let callCount = 0;
      const combinedDb = {
        select: jest.fn().mockImplementation(() => {
          callCount++;
          return callCount === 1 ? wonStagesChain : db;
        }),
      };
      (db as Record<string, unknown>).select = combinedDb.select;
      (wonStagesChain as Record<string, unknown>).select = combinedDb.select;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CrmAttributionReportService,
          { provide: DRIZZLE, useValue: combinedDb },
        ],
      }).compile();

      svc = module.get(CrmAttributionReportService);
      const result = await svc.getFirstTouchAttribution(ORG);
      expect(result[0].roi).toBe(0);
      expect(result[0].dealRevenueCents).toBe(100000);
      expect(result[0].convertedLeads).toBe(2);
    });

    it("computes positive ROI correctly", async () => {
      const rows = [
        {
          campaignId: 2,
          campaignName: "Black Friday",
          touchCount: 10,
          convertedLeads: 4,
          totalRevenue: 3000,
          spend: 1000,
        },
      ];

      const db: Record<string, unknown> = {};
      db.from = jest.fn().mockReturnValue(db);
      db.leftJoin = jest.fn().mockReturnValue(db);
      db.where = jest.fn().mockReturnValue(db);
      db.groupBy = jest.fn().mockResolvedValue(rows);

      const wonStagesChain: Record<string, unknown> = {};
      wonStagesChain.from = jest.fn().mockReturnValue(wonStagesChain);
      wonStagesChain.where = jest.fn().mockResolvedValue([{ key: "WON" }]);

      let call = 0;
      const combinedDb = {
        select: jest.fn().mockImplementation(() => {
          call++;
          return call === 1 ? wonStagesChain : db;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CrmAttributionReportService,
          { provide: DRIZZLE, useValue: combinedDb },
        ],
      }).compile();

      svc = module.get(CrmAttributionReportService);
      const result = await svc.getFirstTouchAttribution(ORG);
      expect(result[0].roi).toBe(200);
      expect(result[0].dealRevenueCents).toBe(300000);
    });
  });

  describe("getLastTouchAttribution — subquery chain", () => {
    it.todo(
      "last-touch uses a subquery (.as()) to find max occurredAt per lead — mock chain depth makes this an integration-level test; cover in e2e",
    );
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
