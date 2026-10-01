jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OrgPurgeService } from "./org-purge.service";
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

function isNextActiveOrgQuery(query: unknown): boolean {
  if (query === null || typeof query !== "object") return false;
  try {
    return new PgDialect().sqlToQuery(query as SQL).sql.includes("next_active_org_ids");
  } catch {
    return false;
  }
}

function updateResult() {
  return {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("OrgPurgeService", () => {
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateMany = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateNamespace = jest.fn().mockResolvedValue(undefined);
  const revokeOrgScopedAccess = jest.fn().mockResolvedValue(undefined);
  const auditLog = jest.fn();
  const sagaBegin = jest.fn();
  const sagaRunStep = jest.fn();
  const sagaComplete = jest.fn().mockResolvedValue(undefined);
  const sagaCompensate = jest.fn().mockResolvedValue(undefined);
  let selectResults: unknown[][];
  let nextActiveOrgRows: unknown[];
  let db: {
    execute: jest.Mock;
    select: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };
  let service: OrgPurgeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    selectResults = [];
    nextActiveOrgRows = [];
    db = {
      // resolveReplacementOrgIds is one call to app.next_active_org_ids for the whole
      // cohort, not one select per member, so it arrives here rather than through
      // `select`. Everything else reaching execute is tenant-GUC plumbing.
      execute: jest.fn().mockImplementation((query: unknown) =>
        Promise.resolve(isNextActiveOrgQuery(query) ? nextActiveOrgRows : []),
      ),
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
        OrgPurgeService,
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
    service = moduleRef.get(OrgPurgeService);
  });

  it("does not delete when confirmation belongs to another organization", async () => {
    selectResults.push([{ id: "org-1", name: "Alpha", slug: "alpha" }]);

    await expect(
      service.deleteOrg("org-1", "user-1", "beta"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(revokeOrgScopedAccess).not.toHaveBeenCalled();
  });

  it("returns the owner's next organization after deleting their active organization", async () => {
    selectResults.push(
      [{ id: "org-1", name: "Alpha", slug: "alpha", statusV2: "ACTIVE" }],
      [],
      [{ userId: "user-1" }],
    );
    nextActiveOrgRows = [{ user_id: "user-1", next_org_id: "org-2" }];

    await expect(
      service.deleteOrg("org-1", "user-1", "Alpha"),
    ).resolves.toEqual({ success: true, nextOrgId: "org-2" });

    expect(revokeOrgScopedAccess).toHaveBeenCalledWith("org-1", "user-1", "removed");
    expect(cacheInvalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
  });

  describe("saga wiring", () => {
    it("deleteOrg: failure in delete-org-data calls compensate and rethrows", async () => {
      selectResults.push(
        [{ id: "org-1", name: "Alpha", slug: "alpha", statusV2: "ACTIVE" }],
        [],
        [{ userId: "user-1" }],
    );
    nextActiveOrgRows = [{ user_id: "user-1", next_org_id: "org-2" }];

      const boom = new Error("delete failed");
      sagaRunStep.mockImplementation(
        (_sagaId: string, stepName: string, fn: () => Promise<unknown>) => {
          if (stepName === "delete-org-data") throw boom;
          return fn();
        },
      );

      await expect(service.deleteOrg("org-1", "user-1", "Alpha")).rejects.toBe(boom);
      expect(sagaCompensate).toHaveBeenCalledWith("test-saga-1", {});
    });

    it("deleteOrg: retry skips validate steps that are already DONE", async () => {
      selectResults.push(
        [{ id: "org-1", name: "Alpha", slug: "alpha", statusV2: "ACTIVE" }],
        [],
        [{ userId: "user-1" }],
    );
    nextActiveOrgRows = [{ user_id: "user-1", next_org_id: "org-2" }];

      sagaBegin.mockResolvedValueOnce({
        saga: { sagaId: "resume-delete-1" },
        steps: [
          { stepName: "validate-confirmation", state: "DONE" },
          { stepName: "validate-no-legal-hold", state: "DONE" },
          { stepName: "delete-org-data", state: "PENDING" },
          { stepName: "remove-placement", state: "PENDING" },
        ],
      });

      await service.deleteOrg("org-1", "user-1", "Alpha");

      const runStepCalls = sagaRunStep.mock.calls.map((c) => c[1] as string);
      expect(runStepCalls).not.toContain("validate-confirmation");
      expect(runStepCalls).not.toContain("validate-no-legal-hold");
      expect(runStepCalls).toContain("delete-org-data");
      expect(runStepCalls).toContain("remove-placement");
    });
  });
});
