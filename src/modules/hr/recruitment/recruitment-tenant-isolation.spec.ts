import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { RecruitmentAutomationService } from "./recruitment-automation.service";
import { RecruitmentCalibrationService } from "./recruitment-calibration.service";
import { RecruitmentCandidateAiService } from "./recruitment-candidate-ai.service";
import { RecruitmentCandidateDocsService } from "./recruitment-candidate-docs.service";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";
import { RecruitmentJobBoardsService } from "./recruitment-job-boards.service";
import { RecruitmentJobsService } from "./recruitment-jobs.service";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentRecruitersService } from "./recruitment-recruiters.service";
import { RecruitmentReferralChecksService } from "./recruitment-referral-checks.service";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import { RecruitmentTalentPoolsService } from "./recruitment-talent-pools.service";
import { RecruitmentVendorSourcingService } from "./recruitment-vendor-sourcing.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
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
  from: jest.Mock; leftJoin: jest.Mock; innerJoin: jest.Mock; where: jest.Mock;
  orderBy: jest.Mock; groupBy: jest.Mock; limit: jest.Mock; offset: jest.Mock;
  having: jest.Mock; as: jest.Mock;
  then: <T>(resolve: (rows: unknown[]) => T) => Promise<T>;
};

function makeChainBuilder(rows: unknown[], visibleRows = rows): { builder: ChainBuilder; where: jest.Mock } {
  const where = jest.fn();
  const builder: ChainBuilder = {
    from: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(), where,
    orderBy: jest.fn(), groupBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    having: jest.fn(), as: jest.fn().mockReturnValue({}),
    then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(visibleRows).then(resolve),
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

function makeDb(rows: unknown[], visibleRows = rows): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const { builder, where } = makeChainBuilder(rows, visibleRows);
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    query: {
      pipelineAutomations: { findMany, findFirst },
      emailSequences: { findMany, findFirst },
      calibrationSessions: { findMany, findFirst },
      candidates: { findMany, findFirst },
      candidateApplications: { findMany, findFirst },
      candidateDocuments: { findMany, findFirst },
      candidateDocumentsVault: { findMany, findFirst },
      candidateMessages: { findMany, findFirst },
      candidateOffers: { findMany, findFirst },
      candidateReferenceChecks: { findMany, findFirst },
      candidateReferrals: { findMany, findFirst },
      candidateSlaTracking: { findMany, findFirst },
      candidateSources: { findMany, findFirst },
      interviews: { findMany, findFirst },
      jobBoardPostings: { findMany, findFirst },
      jobPostings: { findMany, findFirst },
      jobRequisitions: { findMany, findFirst },
      talentPools: { findMany, findFirst },
      talentPoolMembers: { findMany, findFirst },
      organizations: { findMany, findFirst },
      users: { findMany, findFirst },
      externalReferrals: { findMany, findFirst },
      recruitmentVendors: { findMany, findFirst },
    },
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function makeCacheMock() {
  return {
    cachedVersioned: jest.fn().mockImplementation(
      (_k: string, _v: string, cb: () => Promise<unknown>) => cb(),
    ),
    cached: jest.fn().mockImplementation((_k: string, cb: () => Promise<unknown>) => cb()),
    invalidateNamespace: jest.fn(),
  };
}

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

describe("HR Recruitment services — cross-tenant isolation", () => {
  describe("RecruitmentVendorSourcingService", () => {
    it("hides a vendor owned by another org from the requesting org (DENY — cross-tenant isolation)", async () => {
      const foreignVendor = { id: 17, orgId: OWNER, name: "Owner-only vendor" };
      const { db, where } = makeDb([foreignVendor], []);
      const svc = new RecruitmentVendorSourcingService(db);

      const result = await svc.listVendors(ATTACKER);

      expect(foreignVendor.orgId).toBe(OWNER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg))).toContain(ATTACKER);
    });
  });

  describe("RecruitmentAutomationService", () => {
    it("scopes automations to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new RecruitmentAutomationService(db, {} as never);
      const result = await svc.listAutomations(ATTACKER);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns automations for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentAutomationService(db, {} as never);
      const result = await svc.listAutomations(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentCalibrationService", () => {
    it("refuses a candidate outside the requesting org (DENY — 404, not an empty list)", async () => {
      const { db, findMany, findFirst } = makeDb([]);
      const svc = new RecruitmentCalibrationService(db);

      await expect(svc.listCalibration(ATTACKER, 1)).rejects.toThrow(NotFoundException);

      expect(findMany).not.toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns calibration for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, participants: [] }]);
      const svc = new RecruitmentCalibrationService(db);
      const result = await svc.listCalibration(OWNER, 1);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentCandidateAiService", () => {
    it("hides candidate AI score for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentCandidateAiService(db, {} as never);
      await expect(svc.aiScore(ATTACKER, 1, "user-1")).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("scopes candidate AI score to the owning org (CONTROL)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentCandidateAiService(db, {} as never);
      await svc.aiScore(OWNER, 1, "user-1").catch(() => {});
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("RecruitmentCandidateDocsService", () => {
    it("hides candidate documents for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentCandidateDocsService(db, {} as never);
      await expect(svc.listDocuments(ATTACKER, 1)).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("scopes candidate documents to the owning org (CONTROL)", async () => {
      const { db, findFirst, where } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentCandidateDocsService(db, {} as never);
      await svc.listDocuments(OWNER, 1).catch(() => {});
      const allValues = [
        ...findFirst.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg)),
        ...where.mock.calls.flatMap((call: unknown[]) => call).flatMap((arg) => sqlValues(arg)),
      ];
      expect(allValues).toContain(OWNER);
    });
  });

  describe("RecruitmentCandidateOpsService", () => {
    it("scopes candidate lookup to the requesting org during bulk import (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const cache = makeCacheMock();
      const svc = new RecruitmentCandidateOpsService(
        db, {} as never, cache as never, {} as never, {} as never,
      );
      await svc.bulkImport(ATTACKER, { rows: [] });
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("uses the owning org for candidate deduplication (CONTROL)", async () => {
      const { db, findMany } = makeDb([{ email: "existing@example.com" }]);
      const cache = makeCacheMock();
      const svc = new RecruitmentCandidateOpsService(
        db, {} as never, cache as never, {} as never, {} as never,
      );
      await svc.bulkImport(OWNER, { rows: [] });
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("RecruitmentCandidateVaultService", () => {
    it("hides vault for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentCandidateVaultService(db);
      await expect(svc.listVault(ATTACKER, 1)).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns vault documents for the owning org (CONTROL)", async () => {
      const { db, findMany } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentCandidateVaultService(db);
      const result = await svc.listVault(OWNER, 1);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentCandidatesService", () => {
    it("scopes candidate list to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const cache = makeCacheMock();
      const svc = new RecruitmentCandidatesService(
        db, cache as never, {} as never, {} as never,
        {} as never, {} as never, {} as never, {} as never,
      );
      const result = await svc.list(ATTACKER, { page: 1, pageSize: 10, limit: 10, offset: 0, status: undefined, source: undefined, jobId: undefined, search: undefined });
      expect(result.items).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns candidates for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER, email: "c@ex.com" }]);
      const cache = makeCacheMock();
      const svc = new RecruitmentCandidatesService(
        db, cache as never, {} as never, {} as never,
        {} as never, {} as never, {} as never, {} as never,
      );
      const result = await svc.list(OWNER, { page: 1, pageSize: 10, limit: 10, offset: 0, status: undefined, source: undefined, jobId: undefined, search: undefined });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("RecruitmentHandoffService", () => {
    it("scopes candidate lookup to the requesting org (cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentHandoffService(db, {} as never);
      await svc.handleOfferAccepted(ATTACKER, 1, 1);
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("uses the owning org for the handoff (CONTROL)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentHandoffService(db, {} as never);
      await svc.handleOfferAccepted(OWNER, 1, 1);
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("RecruitmentJobBoardsService", () => {
    it("refuses a job posting outside the requesting org (DENY — 404, not an empty list)", async () => {
      const { db, where, findFirst } = makeDb([]);
      const svc = new RecruitmentJobBoardsService(db);

      await expect(svc.list(ATTACKER, 1)).rejects.toThrow(NotFoundException);

      expect(where).not.toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns job board postings for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentJobBoardsService(db);
      const result = await svc.list(OWNER, 1);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentJobsService", () => {
    it("scopes job listings to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const cache = makeCacheMock();
      const svc = new RecruitmentJobsService(db, cache as never, {} as never);
      const result = await svc.list(ATTACKER, { pageSize: 10, limit: 10, status: undefined, cursor: undefined });
      expect(result.items).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns jobs for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const cache = makeCacheMock();
      const svc = new RecruitmentJobsService(db, cache as never, {} as never);
      const result = await svc.list(OWNER, { pageSize: 10, limit: 10, status: undefined, cursor: undefined });
      expect(result.items).toHaveLength(1);
    });
  });

  describe("RecruitmentOffersService", () => {
    it("scopes offers to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RecruitmentOffersService(db, {} as never, {} as never, {} as never);
      const result = await svc.listAllOffers(ATTACKER, { pageSize: 10 });
      expect(result.items).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns offers for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentOffersService(db, {} as never, {} as never, {} as never);
      const result = await svc.listAllOffers(OWNER, { pageSize: 10 });
      expect(result.items).toHaveLength(1);
    });

    it("trims the keyset sentinel and exposes an opaque next cursor", async () => {
      const rows = [
        { id: 2, orgId: OWNER, createdAt: new Date("2026-08-20T09:00:00.000Z") },
        { id: 1, orgId: OWNER, createdAt: new Date("2026-08-20T08:00:00.000Z") },
      ];
      const { db } = makeDb(rows);
      const svc = new RecruitmentOffersService(db, {} as never, {} as never, {} as never);
      const result = await svc.listAllOffers(OWNER, { pageSize: 1 });

      expect(result.items).toEqual([rows[0]]);
      expect(result.pagination).toMatchObject({ limit: 1, hasMore: true });
      expect(result.pagination.nextCursor).toEqual(expect.any(String));
    });
  });

  describe("RecruitmentPipelineService", () => {
    it("scopes pipeline to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const cache = makeCacheMock();
      const svc = new RecruitmentPipelineService(db, cache as never);
      await svc.pipeline(ATTACKER);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns pipeline for the owning org (CONTROL)", async () => {
      const { db, findMany } = makeDb([{ id: 1, orgId: OWNER }]);
      const cache = makeCacheMock();
      const svc = new RecruitmentPipelineService(db, cache as never);
      await svc.pipeline(OWNER);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("RecruitmentRecruitersService", () => {
    it("scopes recruiter portals to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RecruitmentRecruitersService(db, {} as never);
      const result = await svc.listPortals(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns recruiter portals for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentRecruitersService(db, {} as never);
      const result = await svc.listPortals(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentReferralChecksService", () => {
    it("hides reference checks for a different org (DENY — cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      const svc = new RecruitmentReferralChecksService(db);
      await expect(svc.listReferenceChecks(ATTACKER, 1)).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("scopes reference checks to the owning org (CONTROL)", async () => {
      const { db, findFirst } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentReferralChecksService(db);
      const result = await svc.listReferenceChecks(OWNER, 1);
      expect(result).toHaveLength(1);
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(OWNER);
    });
  });

  describe("RecruitmentRequisitionsService", () => {
    it("scopes requisitions to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RecruitmentRequisitionsService(db);
      const result = await svc.list(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns requisitions for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentRequisitionsService(db);
      const result = await svc.list(OWNER);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentSourcingService", () => {
    it("scopes referrals to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, findMany } = makeDb([]);
      const svc = new RecruitmentSourcingService(db, {} as never);
      const result = await svc.listReferrals(ATTACKER, "user-1", true);
      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
      const call = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });

    it("returns referrals for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentSourcingService(db, {} as never);
      const result = await svc.listReferrals(OWNER, "user-1", true);
      expect(result).toHaveLength(1);
    });
  });

  describe("RecruitmentVendorSourcingService", () => {
    it("hides a vendor owned by another org before listing its submissions (DENY â€” cross-tenant isolation)", async () => {
      const { db, findFirst } = makeDb([]);
      findFirst.mockImplementation(({ where }: { where?: unknown }) =>
        Promise.resolve(sqlValues(where).includes(ATTACKER) ? null : { id: 1, orgId: OWNER }),
      );
      const svc = new RecruitmentVendorSourcingService(db);

      await expect(svc.listSubmissions(ATTACKER, 1, false)).rejects.toThrow();
      expect(findFirst).toHaveBeenCalled();
      const call = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(call?.where)).toContain(ATTACKER);
    });
  });

  describe("RecruitmentTalentPoolsService", () => {
    it("scopes talent pools to the requesting org (DENY — cross-tenant isolation)", async () => {
      const { db, where } = makeDb([]);
      const svc = new RecruitmentTalentPoolsService(db);
      const result = await svc.list(ATTACKER);
      expect(result).toHaveLength(0);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
    });

    it("returns talent pools for the owning org (CONTROL)", async () => {
      const { db } = makeDb([{ id: 1, orgId: OWNER }]);
      const svc = new RecruitmentTalentPoolsService(db);
      const result = await svc.list(OWNER);
      expect(result).toHaveLength(1);
    });
  });
});
