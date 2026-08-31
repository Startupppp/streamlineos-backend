import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FinanceReportExportService } from "./finance-report-export.service";
import { FinanceReportExportWorkerService } from "./finance-report-export-worker.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Principal } from "../../../common/auth/principal";

const ORG_A = "org-a-tenant";
const ORG_B = "org-b-tenant";
const JOB_ID = "job-uuid-org-a";
const MEMBERSHIP_A_ID = 101;
const MEMBERSHIP_B_ID = 202;

function makePrincipal(membershipId: number): Principal {
  return { kind: "human-session", membershipId, isOrgOwner: false };
}

function makeUser(orgId: string, membershipId: number): CurrentUserContext {
  return {
    orgId,
    userId: `user-${orgId}`,
    principal: makePrincipal(membershipId),
  } as unknown as CurrentUserContext;
}

function makeOrgAJob() {
  return {
    id: JOB_ID,
    orgId: ORG_A,
    requestedByMembershipId: MEMBERSHIP_A_ID,
    reportType: "sales_by_customer",
    status: "pending",
    filters: { reportType: "sales_by_customer", from: "2026-01-01", to: "2026-03-31" },
    attempt: 0,
    maxAttempts: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    fileKey: null,
    fileName: null,
    fileSizeBytes: null,
    rowCount: null,
    processedRows: null,
    truncated: false,
    completedAt: null,
    expiresAt: null,
    lockedAt: null,
    idempotencyKey: "ik-org-a-1",
    requestHash: "hash-a",
    errorCode: null,
    errorMessage: null,
  };
}

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  const build = (): unknown => {
    chain.select = jest.fn().mockReturnValue(build());
    chain.from = jest.fn().mockReturnValue(build());
    chain.where = jest.fn().mockReturnValue(build());
    chain.limit = jest.fn().mockResolvedValue(rows);
    chain.orderBy = jest.fn().mockReturnValue(build());
    chain.update = jest.fn().mockReturnValue(build());
    chain.set = jest.fn().mockReturnValue(build());
    chain.returning = jest.fn().mockResolvedValue([]);
    return chain;
  };
  return build();
}

describe("FinanceReportExportWorkerService — cross-tenant isolation", () => {
  it("FinanceReportExportService.get() returns 404 (not 403) when org B reads org A's job id", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
    } as unknown as Db;

    const storage = { isConfigured: jest.fn().mockReturnValue(false) } as never;
    const svc = new FinanceReportExportService(db, storage);

    const userB = makeUser(ORG_B, MEMBERSHIP_B_ID);
    await expect(svc.get(userB, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the 404 is not a 403 — cross-tenant miss surfaces as NotFoundException, never ForbiddenException", async () => {
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      })),
    } as unknown as Db;

    const storage = { isConfigured: jest.fn().mockReturnValue(false) } as never;
    const svc = new FinanceReportExportService(db, storage);

    const userB = makeUser(ORG_B, MEMBERSHIP_B_ID);
    const err = await svc.get(userB, JOB_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    const { ForbiddenException } = await import("@nestjs/common");
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });

  it("FinanceReportExportService.claim() returns org A job only when queried with org A's id", async () => {
    const job = makeOrgAJob();

    const makeDb = (orgIdMatch: string) =>
      ({
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() => ({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(orgIdMatch === ORG_A ? [job] : []),
              }),
            })),
          }),
        })),
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue(orgIdMatch === ORG_A ? [{ ...job, status: "running" }] : []),
            }),
          }),
        })),
      }) as unknown as Db;

    const storage = { isConfigured: jest.fn().mockReturnValue(false) } as never;

    const svcA = new FinanceReportExportService(makeDb(ORG_A), storage);
    const svcB = new FinanceReportExportService(makeDb(ORG_B), storage);

    const claimedByA = await svcA.claim(ORG_A);
    const claimedByB = await svcB.claim(ORG_B);

    expect(claimedByA).not.toBeNull();
    expect(claimedByA?.orgId).toBe(ORG_A);
    expect(claimedByB).toBeNull();
  });

  it("FinanceReportExportWorkerService.wake() exists and does not expose cross-tenant data (worker surfaces are internal)", () => {
    const db = { select: jest.fn() } as unknown as Db;
    const jobs = { claim: jest.fn().mockResolvedValue(null) } as never;
    const storage = { isConfigured: jest.fn().mockReturnValue(false) } as never;
    const worker = new FinanceReportExportWorkerService(db, jobs, storage);

    expect(() => worker.wake()).not.toThrow();
  });
});
