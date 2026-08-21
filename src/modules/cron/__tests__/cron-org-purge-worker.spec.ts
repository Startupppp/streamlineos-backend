import { Test } from "@nestjs/testing";
import { CronOrgPurgeWorkerService } from "../cron-org-purge-worker.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { OrgMembershipService } from "../../organization/core/org-membership.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";
const MEMBER_ID = "user-bbbbbbbb-0000-0000-0000-000000000001";

const mockAudit = { log: jest.fn() };
const mockCache = {
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};
const mockOrgMembership = {
  revokeOrgScopedAccess: jest.fn().mockResolvedValue(undefined),
};

describe("CronOrgPurgeWorkerService — both status columns stay consistent", () => {
  let svc: CronOrgPurgeWorkerService;
  let mockDb: {
    select: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrgMembership.revokeOrgScopedAccess.mockResolvedValue(undefined);
    mockCache.invalidate.mockResolvedValue(undefined);
    mockCache.invalidateNamespace.mockResolvedValue(undefined);

    mockDb = {
      select: jest.fn(),
      transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CronOrgPurgeWorkerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
        { provide: OrgMembershipService, useValue: mockOrgMembership },
      ],
    }).compile();

    svc = module.get(CronOrgPurgeWorkerService);
  });

  it("sets statusV2 = PURGED and status = PURGED in the same transaction so legacy readers exclude the org", async () => {
    const memberLimit = { where: jest.fn().mockResolvedValue([{ userId: MEMBER_ID }]) };
    const memberFrom = { from: jest.fn().mockReturnValue(memberLimit) };
    const limitChain = { limit: jest.fn().mockResolvedValue([{ id: ORG_ID }]) };
    const whereChain = { where: jest.fn().mockReturnValue(limitChain) };
    const fromChain = { from: jest.fn().mockReturnValue(whereChain) };
    mockDb.select
      .mockReturnValueOnce(fromChain)
      .mockReturnValueOnce(memberFrom);

    let capturedSetArg: Record<string, unknown> | undefined;

    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockResolvedValue([{
          id: ORG_ID,
          name: "Purge Corp",
          purge_job_id: null,
        }]),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockImplementation((arg: Record<string, unknown>) => {
            capturedSetArg = arg;
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        }),
      };
      return fn(tx);
    });

    const result = await svc.run();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);

    expect(capturedSetArg).toMatchObject({
      statusV2: "PURGED",
      status: "PURGED",
    });
    expect(capturedSetArg?.purgedAt).toBeInstanceOf(Date);
    expect(mockOrgMembership.revokeOrgScopedAccess).toHaveBeenCalledWith(ORG_ID, MEMBER_ID);
  });

  it("skips purge and reports skipped=1 when the row is already claimed (SKIP LOCKED returns nothing)", async () => {
    const memberLimit = { where: jest.fn().mockResolvedValue([]) };
    const memberFrom = { from: jest.fn().mockReturnValue(memberLimit) };
    const limitChain = { limit: jest.fn().mockResolvedValue([{ id: ORG_ID }]) };
    const whereChain = { where: jest.fn().mockReturnValue(limitChain) };
    const fromChain = { from: jest.fn().mockReturnValue(whereChain) };
    mockDb.select
      .mockReturnValueOnce(fromChain)
      .mockReturnValueOnce(memberFrom);

    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      };
      return fn(tx);
    });

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockOrgMembership.revokeOrgScopedAccess).not.toHaveBeenCalled();
  });

  it("returns processed=0 skipped=0 when there are no purge-scheduled candidates", async () => {
    const limitChain = { limit: jest.fn().mockResolvedValue([]) };
    const whereChain = { where: jest.fn().mockReturnValue(limitChain) };
    const fromChain = { from: jest.fn().mockReturnValue(whereChain) };
    mockDb.select.mockReturnValue(fromChain);

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
