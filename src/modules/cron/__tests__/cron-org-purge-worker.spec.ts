import { Test } from "@nestjs/testing";
import { CronOrgPurgeWorkerService } from "../cron-org-purge-worker.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { OrgMembershipService } from "../../organization/core/org-membership.service";
import { StorageService } from "../../storage/storage.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { logger } from "../../../common/logger/logger.service";
import { PURGE_ADAPTERS } from "../../../db/schema/common/organization-purge";
import { PURGE_ADAPTER_REGISTRY } from "../../organization/core/lifecycle/organization-purge-adapters";

jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: () => false,
  recordTargetRequest: jest.fn().mockResolvedValue(undefined),
  countRequestIfRelocationTarget: jest.fn().mockResolvedValue(undefined),
}));

const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";
const MEMBER_ID = "user-bbbbbbbb-0000-0000-0000-000000000001";

const mockAudit = { log: jest.fn() };
const mockCache = {
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};
const mockOrgMembership = {
  revokeOrgScopedAccess: jest.fn().mockResolvedValue(undefined),
};
const mockStorage = {
  deleteFile: jest.fn().mockResolvedValue(undefined),
  isConfigured: jest.fn().mockReturnValue(true),
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
  let mockDb: { select: jest.Mock; transaction: jest.Mock; delete: jest.Mock };
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

    mockDb = { select: jest.fn(), transaction: jest.fn(), delete: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        CronOrgPurgeWorkerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
        { provide: OrgMembershipService, useValue: mockOrgMembership },
        { provide: StorageService, useValue: mockStorage },
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
      .mockReturnValueOnce(
        selectReturning([{ id: ORG_ID, name: "Purge Corp", purgeJobId: null }]),
      )
      .mockReturnValue(memberSelect([{ userId: MEMBER_ID }]));

    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        // no unreleased hold; the read is inside the transaction so RLS is satisfied
        select: jest.fn().mockReturnValue(selectReturning([])),
        execute: jest.fn().mockResolvedValue([{ id: ORG_ID }]),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ id: ORG_ID }]) }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
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
    expect(capturedSetArg()).toBeUndefined();
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
    mockDb.select.mockReturnValueOnce(selectReturning([{ id: ORG_ID }]));

    let transactions = 0;
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      if (transactions > 1)
        throw new Error("a held organization must not reach any purge transaction");
      return fn({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue(selectReturning([{ holdId: "hold-1" }])),
      });
    });

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("reads the legal hold inside a tenant transaction, because a pool read dies 42501 under RLS", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select.mockImplementation(() => {
      throw new Error(
        "organization_legal_holds read on the pool: no tenant GUC, dies 42501",
      );
    });
    mockDb.select.mockReturnValueOnce(selectReturning([{ id: ORG_ID }]));

    let sawHoldRead = false;
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      sawHoldRead = true;
      return fn({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue(selectReturning([{ holdId: "hold-1" }])),
      });
    });

    const result = await svc.run();

    expect(sawHoldRead).toBe(true);
    expect(result.processed).toBe(0);
  });

  it("skips an org that is no longer purge-scheduled", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ id: ORG_ID }]))
      .mockReturnValueOnce(selectReturning([]));
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue(selectReturning([])),
      }),
    );
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(info.mock.calls.map((c) => String(c[0])).join(" | ")).toContain(
      "no longer purge-scheduled",
    );
    info.mockRestore();
  });

  it("skips when another instance already claimed the row (SKIP LOCKED returns nothing)", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ id: ORG_ID }]))
      .mockReturnValueOnce(
        selectReturning([{ id: ORG_ID, name: "Purge Corp", purgeJobId: null }]),
      )
      .mockReturnValue(memberSelect([]));

    // The final claim transaction is the one that must come back empty; the
    // earlier tenant transactions still have to work or we never reach it.
    let txCount = 0;
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      txCount += 1;
      return fn({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue(selectReturning([])),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
    });
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);

    const result = await svc.run();

    expect(txCount).toBeGreaterThan(2);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(info.mock.calls.map((c) => String(c[0])).join(" | ")).toContain(
      "claimed by another instance",
    );
    expect(mockOrgMembership.revokeOrgScopedAccess).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("names the real reason for a skip rather than blaming another instance", async () => {
    restoreAdapters = setAdapterStates("FAILED");
    stubHappyPath();
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);

    await svc.run();

    const warned = warn.mock.calls.map((c) => String(c[0])).join(" | ");
    const informed = info.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(warned).toContain("adapter confirmations incomplete");
    expect(informed).not.toContain("claimed by another instance");

    warn.mockRestore();
    info.mockRestore();
  });

  it("warns, rather than merely informs, when a legal hold blocks a purge", async () => {
    restoreAdapters = setAdapterStates("CONFIRMED");
    mockDb.select.mockReturnValueOnce(selectReturning([{ id: ORG_ID }]));
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue(selectReturning([{ holdId: "hold-1" }])),
      }),
    );
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);

    await svc.run();

    expect(warn.mock.calls.map((c) => String(c[0])).join(" | ")).toContain(
      "blocked by an active legal hold",
    );
    warn.mockRestore();
  });

  it("returns processed=0 skipped=0 when there are no purge-scheduled candidates", async () => {
    mockDb.select.mockReturnValue(selectReturning([]));

    const result = await svc.run();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
