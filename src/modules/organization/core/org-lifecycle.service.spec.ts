jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

function queryResult(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  for (const method of ["from", "innerJoin", "where", "orderBy"]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

function updateResult() {
  return {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("OrgLifecycleService", () => {
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateMany = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateNamespace = jest.fn().mockResolvedValue(undefined);
  const revokeOrgScopedAccess = jest.fn().mockResolvedValue(undefined);
  const revokeAllPending = jest.fn().mockResolvedValue(undefined);
  const auditLog = jest.fn();
  const sagaBegin = jest.fn();
  const sagaRunStep = jest.fn();
  const sagaComplete = jest.fn().mockResolvedValue(undefined);
  const sagaCompensate = jest.fn().mockResolvedValue(undefined);
  let selectResults: unknown[][];
  let db: {
    execute: jest.Mock;
    select: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };
  let service: OrgLifecycleService;

  beforeEach(async () => {
    jest.clearAllMocks();
    selectResults = [];
    db = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn(() => queryResult(selectResults.shift() ?? [])),
      update: jest.fn(() => updateResult()),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
      transaction: jest.fn(
        (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
      ),
    };

    sagaBegin.mockResolvedValue({ saga: { sagaId: "test-saga-1" }, steps: [] });
    sagaRunStep.mockImplementation(
      (_sagaId: string, _stepName: string, fn: () => Promise<unknown>) => fn(),
    );
    sagaComplete.mockResolvedValue(undefined);
    sagaCompensate.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: auditLog } },
        {
          provide: CacheService,
          useValue: {
            invalidate: cacheInvalidate,
            invalidateNamespace: cacheInvalidateNamespace,
            invalidateMany: cacheInvalidateMany,
            invalidateNamespaceMany: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: OrgMembershipService,
          useValue: { revokeOrgScopedAccess },
        },
        { provide: InvitationLifecycleService, useValue: { revokeAllPending } },
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: sagaBegin,
            runStep: sagaRunStep,
            complete: sagaComplete,
            compensate: sagaCompensate,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(OrgLifecycleService);
  });

  it("archives atomically, moves the active org, and evicts only org-scoped access", async () => {
    selectResults.push(
      [{ statusV2: "ACTIVE" }],
      [],
      [{ userId: "user-1" }],
      [{ orgId: "org-2" }],
    );

    await expect(service.archiveOrg("org-1", "user-1")).resolves.toEqual({
      success: true,
      nextOrgId: "org-2",
    });

    expect(db.transaction).toHaveBeenCalledTimes(4);
    expect(revokeAllPending).toHaveBeenCalledWith("org-1", db);
    expect(revokeOrgScopedAccess).toHaveBeenCalledWith("org-1", "user-1", "removed");
    // The session bust is batched: one invalidateMany carrying every member's key,
    // rather than one invalidate per member.
    expect(cacheInvalidateMany).toHaveBeenCalledWith(
      expect.arrayContaining([CACHE_KEYS.userSession("user-1")]),
    );
  });

  it("hides another tenant's archived organization during restore", async () => {
    selectResults.push([]);

    await expect(service.restoreOrg("org-other", "user-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("requires an active owner membership to restore an archived organization", async () => {
    selectResults.push([
      { orgStatus: "ARCHIVED", isOwner: true, memberStatus: "SUSPENDED" },
    ]);

    await expect(service.restoreOrg("org-1", "user-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects restore when the organization is already active", async () => {
    selectResults.push([
      { orgStatus: "ACTIVE", isOwner: true, memberStatus: "ACTIVE" },
    ]);

    await expect(service.restoreOrg("org-1", "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe("saga wiring", () => {
    it("archiveOrg: retry skips steps already DONE and does not repeat them", async () => {
      selectResults.push(
        [{ statusV2: "ACTIVE" }],
        [],
        [{ userId: "user-1" }],
        [{ orgId: "org-2" }],
      );

      sagaBegin.mockResolvedValueOnce({
        saga: { sagaId: "resume-saga-1" },
        steps: [
          { stepName: "revoke-invitations", state: "DONE" },
          { stepName: "set-status-archived", state: "PENDING" },
          { stepName: "revoke-member-access", state: "PENDING" },
        ],
      });

      await service.archiveOrg("org-1", "user-1");

      const runStepCalls = sagaRunStep.mock.calls.map((c) => c[1] as string);
      expect(runStepCalls).not.toContain("revoke-invitations");
      expect(runStepCalls).toContain("set-status-archived");
      expect(runStepCalls).toContain("revoke-member-access");
      expect(revokeAllPending).not.toHaveBeenCalled();
    });

    it("archiveOrg: failure mid-step calls compensate and rethrows", async () => {
      selectResults.push(
        [{ statusV2: "ACTIVE" }],
        [],
        [{ userId: "user-1" }],
        [{ orgId: "org-2" }],
      );

      const boom = new Error("DB exploded");
      sagaRunStep.mockImplementation(
        (_sagaId: string, stepName: string, fn: () => Promise<unknown>) => {
          if (stepName === "set-status-archived") throw boom;
          return fn();
        },
      );

      await expect(service.archiveOrg("org-1", "user-1")).rejects.toBe(boom);
      expect(sagaCompensate).toHaveBeenCalledWith("test-saga-1", {});
    });

  });
});
