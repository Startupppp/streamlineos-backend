import type { Db } from "../../../db/drizzle.module";
import { AlumniService } from "./alumni.service";
import { ExitService } from "./exit.service";
import { ExitChecklistService } from "./exit-checklist.service";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { OnboardingViewsService } from "./onboarding-views.service";
import { ProbationReviewReaderService } from "./probation-review-reader.service";
import { ProbationService } from "./probation.service";
import { ResignationJobsService } from "./resignation-jobs.service";
import { TerminationService } from "./termination.service";
import { TerminationReadService } from "./termination-read.service";
import { TerminationCommunicationsService } from "./termination-communications.service";
import { ExperienceLetterService } from "./experience-letter.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";

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
  having: jest.Mock;
  as: jest.Mock;
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
    having: jest.fn(),
    as: jest.fn().mockReturnValue({}),
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
  builder.having.mockReturnValue(builder);
  return { builder, where };
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const { builder, where } = makeChainBuilder(rows);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);

  const db = {
    select: jest.fn().mockReturnValue(builder),
    selectDistinctOn: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db)),
    query: {
      alumniProfiles: { findMany, findFirst },
      resignations: { findMany, findFirst },
      hrTemplates: { findMany, findFirst },
      hrEmployments: { findMany, findFirst },
      hrProbationReviews: { findMany, findFirst },
      terminations: { findMany, findFirst },
      organizationMembers: { findMany, findFirst },
      users: { findMany, findFirst },
      assets: { findMany, findFirst },
    },
  } as unknown as Db;

  return { db, where, findMany, findFirst };
}

function makeCacheMock(): CacheService {
  return {
    cached: jest.fn().mockImplementation((_key: string, cb: () => Promise<unknown>) => cb()),
    cachedVersioned: jest.fn().mockImplementation((_k: string, _v: string, cb: () => Promise<unknown>) => cb()),
    invalidateNamespace: jest.fn(),
  } as unknown as CacheService;
}

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

describe("HR Lifecycle services — cross-tenant isolation", () => {
  describe("AlumniService", () => {
    it("hides alumni profiles for a different org (DENY)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new AlumniService(db);
      const result = await svc.list(ATTACKER, 10);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns alumni profiles for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new AlumniService(db);
      const result = await svc.list(OWNER, 10);
      expect(result).toHaveLength(1);
    });
  });

  describe("ExitService", () => {
    it("hides resignations for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const mockEmployment = {} as unknown as EmploymentFactsService;
      const svc = new ExitService(db, mockEmployment);
      const result = await svc.list(ATTACKER, "user-1", true, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns resignations for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const mockEmployment = {} as unknown as EmploymentFactsService;
      const svc = new ExitService(db, mockEmployment);
      const result = await svc.list(OWNER, "user-1", true, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("ExitChecklistService", () => {
    it("queries templates scoped to the requesting org (cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new ExitChecklistService(db);
      await svc.seedChecklistFromTemplate(ATTACKER, 99);
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("queries templates for the owning org (CONTROL)", async () => {
      const template = {
        id: 1,
        orgId: OWNER,
        content: [{ title: "Task 1" }],
        kind: "offboarding_checklist",
        status: "active",
        deletedAt: null,
      };
      const { db, findFirst } = makeDb([]);
      findFirst.mockResolvedValue(template);
      const svc = new ExitChecklistService(db);
      await svc.seedChecklistFromTemplate(OWNER, 99);
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("HrAnalyticsService", () => {
    it("scopes analytics queries to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockCache = makeCacheMock();
      const svc = new HrAnalyticsService(db, mockCache);
      await svc.overview(ATTACKER);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns analytics for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ count: 1 }]);
      const mockCache = makeCacheMock();
      const svc = new HrAnalyticsService(db, mockCache);
      const result = await svc.overview(OWNER);
      expect(result).toBeDefined();
    });
  });

  describe("HrDashboardService", () => {
    it("scopes dashboard metrics to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockCache = makeCacheMock();
      const svc = new HrDashboardService(db, mockCache);
      await svc.metrics(ATTACKER);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns metrics for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ count: 0 }]);
      const mockCache = makeCacheMock();
      const svc = new HrDashboardService(db, mockCache);
      const result = await svc.metrics(OWNER);
      expect(result).toBeDefined();
    });
  });

  describe("HrDashboardReportsService", () => {
    it("scopes headcount trends to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const mockCache = makeCacheMock();
      const svc = new HrDashboardReportsService(db, mockCache);
      await svc.headcountTrends(ATTACKER);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns headcount trends for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ joiningDate: "2025-01-01" }]);
      const mockCache = makeCacheMock();
      const svc = new HrDashboardReportsService(db, mockCache);
      const result = await svc.headcountTrends(OWNER);
      expect(result).toBeDefined();
    });
  });

  describe("ProbationReviewReaderService", () => {
    it("scopes probation reviews to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new ProbationReviewReaderService(db);
      const result = await svc.listDueForReview(ATTACKER, { limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("returns probation reviews for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, effectiveEndDate: "2026-01-01" }]);
      const svc = new ProbationReviewReaderService(db);
      const result = await svc.listDueForReview(OWNER, { limit: 10 });
      expect(result).toBeDefined();
    });
  });

  describe("TerminationService", () => {
    it("hides terminations for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const reader = new TerminationReadService(db, {} as never);
      const svc = new TerminationService(
        db,
        {} as never, {} as never, {} as never,
        reader, {} as never,
      );
      const result = await svc.list(ATTACKER, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns terminations for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const reader = new TerminationReadService(db, {} as never);
      const svc = new TerminationService(
        db,
        {} as never, {} as never, {} as never,
        reader, {} as never,
      );
      const result = await svc.list(OWNER, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("ProbationService", () => {
    it("delegates probation review listing to the scoped reader (cross-tenant isolation)", async () => {
      const { db } = makeDb([]);
      const mockReader = {
        listDueForReview: jest.fn().mockResolvedValue({ data: [], pageInfo: { hasMore: false, nextCursor: null, limit: 10 } }),
      } as unknown as ProbationReviewReaderService;
      const svc = new ProbationService(
        db,
        {} as never, {} as never, {} as never,
        {} as never, {} as never, {} as never,
        mockReader,
      );
      await svc.listDueForReview(ATTACKER, { limit: 10 });
      expect(mockReader.listDueForReview).toHaveBeenCalledWith(ATTACKER, { limit: 10 });
    });

    it("forwards the owning org to the reader (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1 }]);
      const mockReader = {
        listDueForReview: jest.fn().mockResolvedValue({
          data: [{ id: 1 }],
          pageInfo: { hasMore: false, nextCursor: null, limit: 10 },
        }),
      } as unknown as ProbationReviewReaderService;
      const svc = new ProbationService(
        db,
        {} as never, {} as never, {} as never,
        {} as never, {} as never, {} as never,
        mockReader,
      );
      const result = await svc.listDueForReview(OWNER, { limit: 10 });
      expect(mockReader.listDueForReview).toHaveBeenCalledWith(OWNER, { limit: 10 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe("ResignationJobsService", () => {
    it("scopes notification recipients to the requesting org (cross-tenant isolation)", async () => {
      const { db } = makeDb([]);
      const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue([]) };
      const mockNotif = { sendToUser: jest.fn(), notifyMany: jest.fn() };
      const mockAudit = { log: jest.fn() };
      const svc = new ResignationJobsService(db, mockNotif as never, mockAudit as never, mockAccess as never);
      svc.notifyResignationSubmitted(ATTACKER, "emp-1");
      await new Promise((r) => setImmediate(r));
      expect(mockAccess.membersWithPermission).toHaveBeenCalledWith(ATTACKER, expect.any(String));
    });

    it("uses the correct org when notifying owning org members (CONTROL)", async () => {
      const { db } = makeDb([]);
      const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue(["user-1"]) };
      const mockNotif = { sendToUser: jest.fn(), notifyMany: jest.fn().mockResolvedValue(undefined) };
      const mockAudit = { log: jest.fn() };
      const svc = new ResignationJobsService(db, mockNotif as never, mockAudit as never, mockAccess as never);
      svc.notifyResignationSubmitted(OWNER, "emp-1");
      await new Promise((r) => setImmediate(r));
      expect(mockAccess.membersWithPermission).toHaveBeenCalledWith(OWNER, expect.any(String));
    });
  });

  describe("TerminationCommunicationsService", () => {
    it("hides termination for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new TerminationCommunicationsService(
        db,
        {} as never, {} as never, {} as never,
      );
      await expect(svc.getLetter(ATTACKER, 1)).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("scopes termination query to the owning org (CONTROL)", async () => {
      const { db, findFirst } = makeDb([]);
      const termRow = {
        id: 1, orgId: OWNER, userId: "user-1", effectiveDate: "2026-01-01",
        reasons: [], detailedExplanation: null, noticePeriodWaived: false,
        user: { id: "user-1", name: "Alice" },
      };
      findFirst.mockResolvedValueOnce(termRow);
      const mockEmployment = { getFacts: jest.fn().mockResolvedValue({ designation: "Engineer" }) };
      const svc = new TerminationCommunicationsService(
        db, {} as never, {} as never, mockEmployment as never,
      );
      await svc.getLetter(OWNER, 1).catch(() => {});
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("ExperienceLetterService", () => {
    it("scopes employment queries to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new ExperienceLetterService(db, {} as never);
      await expect(svc.create(ATTACKER, "user-1", { userId: "user-1", relievingDate: "2024-01-01" })).rejects.toThrow();
      expect(where).toHaveBeenCalled();
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("scopes employment queries to the owning org (CONTROL)", async () => {
      const { db, where } = makeDb([]);
      const svc = new ExperienceLetterService(db, {} as never);
      await expect(svc.create(OWNER, "user-1", { userId: "user-1", relievingDate: "2024-01-01" })).rejects.toThrow();
      expect(where).toHaveBeenCalled();
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(OWNER);
    });
  });

  describe("OnboardingViewsService", () => {
    it("scopes onboarding document list to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new OnboardingViewsService(db, {} as never);
      const result = await svc.list(ATTACKER, "user-1", true, { page: 1, limit: 10 }, "all");
      expect(result.data).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      const allValues = where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg));
      expect(allValues).toContain(ATTACKER);
    });

    it("returns onboarding documents for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, userId: "user-1" }]);
      const svc = new OnboardingViewsService(db, {} as never);
      const result = await svc.list(OWNER, "user-1", true, { page: 1, limit: 10 }, "all");
      expect(result.data).toHaveLength(1);
    });
  });
});
