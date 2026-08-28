import { Test } from "@nestjs/testing";
import { CronOrgPurgeWorkerService } from "../cron-org-purge-worker.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { OrgMembershipService } from "../../organization/core/org-membership.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PURGE_ADAPTERS } from "../../../db/schema/common/organization-purge";
import { PURGE_ADAPTER_REGISTRY } from "../../organization/core/lifecycle/organization-purge-adapters";

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

/**
 * Purge completion is gated on every adapter confirming, so the registry is what
 * decides whether the flip is even reachable. Overriding it here is how the
 * completion path stays testable while the real adapters are unimplemented — and
 * the blocking case below asserts the real registry's refusal is honoured.
 */
function setAdapterStates(state: "CONFIRMED" | "FAILED"): () => void {
  const originals = PURGE_ADAPTERS.map(
    (adapter) => [adapter, PURGE_ADAPTER_REGISTRY[adapter].confirm] as const,
  );
  for (const adapter of PURGE_ADAPTERS)
    PURGE_ADAPTER_REGISTRY[adapter].confirm = jest
      .fn()
      .mockResolvedValue({ state, detail: `stubbed ${state}` });

  return () => {
    for (const [adapter, confirm] of originals)
      PURGE_ADAPTER_REGISTRY[adapter].confirm = confirm;
  };
}

describe("CronOrgPurgeWorkerService", () => {
  let svc: CronOrgPurgeWorkerService;
  let mockDb: { select: jest.Mock; transaction: jest.Mock };
  let restoreAdapters: (() => void) | null = null;

  function selectReturning(rows: unknown[]) {
    const limitChain = { limit: jest.fn().mockResolvedValue(rows) };
    const whereChain = {
      where: jest.fn().mockReturnValue(limitChain),
      limit: jest.fn().mockResolvedValue(rows),
    };
    return {
      from: jest.fn().mockReturnValue(whereChain),
    };
  }

  function memberSelect(rows: unknown[]) {
    return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) };
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrgMembership.revokeOrgScopedAccess.mockResolvedValue(undefined);
    mockCache.invalidate.mockResolvedValue(undefined);
    mockCache.invalidateNamespace.mockResolvedValue(undefined);

    mockDb = { select: jest.fn(), transaction: jest.fn() };

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

  afterEach(() => {
    restoreAdapters?.();
    restoreAdapters = null;
  });

  function stubHappyPath(): { capturedSetArg: () => Record<string, unknown> | undefined } {
    let capturedSetArg: Record<string, unknown> | undefined;

    mockDb.select
      .mockReturnValueOnce(selectReturning([{ id: ORG_ID }]))
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(
        selectReturning([{ id: ORG_ID, name: "Purge Corp", purgeJobId: null }]),
      )
      .mockReturnValue(memberSelect([{ userId: MEMBER_ID }]));

    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockResolvedValue([{ id: ORG_ID }]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockImplementation((arg: Record<string, unknown>) => {
            if ("statusV2" in arg && arg.statusV2 === "PURGED") capturedSetArg = arg;
            return { where: jest.fn().mockResolvedValue(undefined) };
          }),
        }),
      };
      return fn(tx);
    });

    return { capturedSetArg: () => capturedSetArg };
  }

  it("sets statusV2 = PURGED and status = PURGED in the same transaction so legacy readers exclude the org", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    const { capturedSetArg } = stubHappyPath();

    const result = await svc.run();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(capturedSetArg()).toMatchObject({ statusV2: "PURGED", status: "PURGED" });
    expect(capturedSetArg()?.purgedAt).toBeInstanceOf(Date);
    expect(mockOrgMembership.revokeOrgScopedAccess).toHaveBeenCalledWith(
      ORG_ID,
      MEMBER_ID,
      "removed",
    );
  });

  it("blocks completion when an adapter cannot confirm deletion, leaving the org PURGE_SCHEDULED", async () => {
    restoreAdapters = setAdapterStates("FAILED");
    const { capturedSetArg } = stubHappyPath();

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(capturedSetArg()).toBeUndefined();
    expect(mockOrgMembership.revokeOrgScopedAccess).not.toHaveBeenCalled();
  });

  it("refuses to purge an organization under an active legal hold", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ id: ORG_ID }]))
      .mockReturnValueOnce(selectReturning([{ holdId: "hold-1" }]));
    mockDb.transaction.mockImplementation(() => {
      throw new Error("a held organization must not reach any purge transaction");
    });

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips purge and reports skipped=1 when the row is already claimed (SKIP LOCKED returns nothing)", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ id: ORG_ID }]))
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([]));

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockOrgMembership.revokeOrgScopedAccess).not.toHaveBeenCalled();
  });

  it("returns processed=0 skipped=0 when there are no purge-scheduled candidates", async () => {
    mockDb.select.mockReturnValue(selectReturning([]));

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
