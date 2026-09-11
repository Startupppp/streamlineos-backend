import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FeedbackService } from "./feedback.service";
import { KpisService } from "./kpis.service";
import { SuccessionService } from "./succession.service";
import { CalibrationService } from "./calibration.service";
import { EngagementBadgesService } from "./engagement-badges.service";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";
import { EngagementService } from "./engagement.service";
import { OneOnOneMeetingsService } from "./one-on-one-meetings.service";
import { PerformanceGoalsService } from "./performance-goals.service";
import { PerformancePipsService } from "./performance-pips.service";
import { RichDocumentsService } from "./rich-documents.service";
import { EngagementCommunitiesCampaignsService } from "./engagement-communities-campaigns.service";
import { ComplianceService } from "./compliance.service";
import { DocumentsService } from "./documents.service";
import { LettersService } from "./letters.service";
import type { AuditService } from "../../../common/audit/audit.service";
import { ScopedRead } from "../../access/scoped-read";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type ChainBuilder = {
  from: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  groupBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
  then: <T>(resolve: (rows: unknown[]) => T) => Promise<T>;
};

function makeChainBuilder(rows: unknown[]): { builder: ChainBuilder; where: jest.Mock } {
  const where = jest.fn();
  const builder: ChainBuilder = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    groupBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  return { builder, where };
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const { builder, where } = makeChainBuilder(rows);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);

  const db = {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
    query: {
      feedbackCycles: { findMany, findFirst },
      goals: { findMany, findFirst },
      keyResults: { findMany, findFirst },
      kpiDefinitions: { findMany, findFirst },
      hrSuccessionPlans: { findMany, findFirst },
      hrCalibrationEntries: { findMany, findFirst },
      reviewCycles: { findMany, findFirst },
      performanceImprovementPlans: { findMany, findFirst },
      oneOnOneMeetings: { findMany, findFirst },
      recognitions: { findMany, findFirst },
      skillAssessments: { findMany, findFirst },
      hrBadges: { findMany, findFirst },
      hrPolls: { findMany, findFirst },
      policyAcknowledgments: { findMany, findFirst },
      documents: { findMany, findFirst },
      certifications: { findMany, findFirst },
      hrTemplates: { findMany, findFirst },
      hrEmployments: { findMany, findFirst },
      organizationMembers: { findMany, findFirst },
    },
  } as unknown as Db;

  return { db, where, findMany, findFirst };
}

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

describe("HR Performance services — cross-tenant isolation", () => {
  describe("FeedbackService", () => {
    it("hides feedback cycles belonging to a different org (DENY)", async () => {
      const { db, where } = makeDb([]);
      const svc = new FeedbackService(db);
      const result = await svc.listCycles(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns cycles for the owning org (CONTROL — isolation is real)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, name: "Q1" }]);
      const svc = new FeedbackService(db);
      const result = await svc.listCycles(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("KpisService", () => {
    it("hides KPIs belonging to a different org (DENY)", async () => {
      const { db, where } = makeDb([]);
      const svc = new KpisService(db);
      const result = await svc.listKpis(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns KPIs for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new KpisService(db);
      const result = await svc.listKpis(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("CalibrationService", () => {
    it("refuses a review cycle outside the org (DENY — 404, not an empty list)", async () => {
      const { db, where, findFirst } = makeDb([]);
      const svc = new CalibrationService(db);

      await expect(svc.listEntries(ATTACKER, 1)).rejects.toThrow(NotFoundException);

      expect(where).not.toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns calibration entries for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new CalibrationService(db);
      const result = await svc.listEntries(OWNER, 1);
      expect(result).toHaveLength(1);
    });
  });

  describe("SuccessionService", () => {
    it("hides succession plans for a different org (DENY)", async () => {
      const { db, where } = makeDb([]);
      const svc = new SuccessionService(db);
      const result = await svc.list(ATTACKER, { limit: 10 });
      expect(result.items).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns succession plans for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new SuccessionService(db);
      const result = await svc.list(OWNER, { limit: 10 });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("EngagementBadgesService", () => {
    it("hides badges for a different org (DENY)", async () => {
      const { db, where } = makeDb([]);
      const svc = new EngagementBadgesService(db);
      const result = await svc.listBadges(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns badges for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new EngagementBadgesService(db);
      const result = await svc.listBadges(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("EngagementMoodPollsService", () => {
    it("hides polls for a different org (DENY)", async () => {
      const { db, where } = makeDb([]);
      const svc = new EngagementMoodPollsService(db);
      const result = await svc.listPolls(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns polls for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new EngagementMoodPollsService(db);
      const result = await svc.listPolls(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("EngagementService", () => {
    it("hides recognitions for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const mockExtras = {} as unknown as EngagementBadgesService;
      const svc = new EngagementService(db, mockExtras);
      const result = await svc.listRecognitions(ATTACKER);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns recognitions for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const mockExtras = {} as unknown as EngagementBadgesService;
      const svc = new EngagementService(db, mockExtras);
      const result = await svc.listRecognitions(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("OneOnOneMeetingsService", () => {
    it("scopes meetings to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new OneOnOneMeetingsService(db);
      const result = await svc.listOneOnOnes(ATTACKER, "user-1", false);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns meetings for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, scheduledAt: null }]);
      const svc = new OneOnOneMeetingsService(db);
      const result = await svc.listOneOnOnes(OWNER, "user-1", false);
      expect(result).toHaveLength(1);
    });
  });

  describe("PerformancePipsService", () => {
    it("scopes PIPs to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new PerformancePipsService(db);
      const result = await svc.listPips(ScopedRead.of(ATTACKER, "user-1", "all"));
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns PIPs for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new PerformancePipsService(db);
      const result = await svc.listPips(ScopedRead.of(OWNER, "user-1", "all"));
      expect(result).toHaveLength(1);
    });
  });

  describe("PerformanceGoalsService", () => {
    it("hides goals for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new PerformanceGoalsService(db);
      const result = await svc.myGoals(ATTACKER, "user-1");
      expect(result.goals).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns goals for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, userId: "user-1" }]);
      const svc = new PerformanceGoalsService(db);
      const result = await svc.myGoals(OWNER, "user-1");
      expect(result.goals).toHaveLength(1);
    });
  });

  describe("RichDocumentsService", () => {
    it("scopes rich document list to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RichDocumentsService(db);
      const result = await svc.list(ATTACKER, { limit: 10, isPublished: undefined });
      expect(result.data).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns rich documents for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RichDocumentsService(db);
      const result = await svc.list(OWNER, { limit: 10, isPublished: undefined });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("EngagementCommunitiesCampaignsService", () => {
    it("hides communities for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new EngagementCommunitiesCampaignsService(db);
      const result = await svc.listCommunities(ATTACKER, { limit: 10 });
      expect(result.items).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns communities for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new EngagementCommunitiesCampaignsService(db);
      const result = await svc.listCommunities(OWNER, { limit: 10 });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("ComplianceService", () => {
    it("hides acknowledgments for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new ComplianceService(db);
      const result = await svc.listAcknowledgments(ScopedRead.of(ATTACKER, "user-1", "all"));
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns acknowledgments for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new ComplianceService(db);
      const result = await svc.listAcknowledgments(ScopedRead.of(OWNER, "user-1", "all"));
      expect(result).toHaveLength(1);
    });
  });

  describe("DocumentsService", () => {
    it("hides documents for a different org (DENY — cross-tenant isolation)", async () => {
      const mockAudit = {} as unknown as AuditService;
      const { db, where } = makeDb([]);
      const svc = new DocumentsService(db, mockAudit);
      const result = await svc.listDocuments(ScopedRead.of(ATTACKER, "user-1", "all"), { limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns documents for the owning org (CONTROL)", async () => {
      const mockAudit = {} as unknown as AuditService;
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new DocumentsService(db, mockAudit);
      const result = await svc.listDocuments(ScopedRead.of(OWNER, "user-1", "all"), { limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("LettersService", () => {
    it("returns NotFoundException when template belongs to a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new LettersService(db);
      await expect(svc.renderLetter(ATTACKER, { templateId: 99 })).rejects.toThrow(NotFoundException);
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns letter for the owning org when template exists (CONTROL)", async () => {
      const { db } = makeDb([{
        id: 99,
        orgId: OWNER,
        name: "Offer Letter",
        letterType: "offer",
        version: 1,
        variablesUsed: [],
        content: { bodyHtml: "Hello" },
        deletedAt: null,
      }]);
      const svc = new LettersService(db);
      const result = await svc.renderLetter(OWNER, { templateId: 99 });
      expect(result.templateId).toBe(99);
    });
  });
});
