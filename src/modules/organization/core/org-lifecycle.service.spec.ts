import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgMembershipService } from "./org-membership.service";

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
  const cacheInvalidateNamespace = jest.fn().mockResolvedValue(undefined);
  const revokeOrgScopedAccess = jest.fn().mockResolvedValue(undefined);
  const revokeAllPending = jest.fn().mockResolvedValue(undefined);
  const auditLog = jest.fn();
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
          },
        },
        {
          provide: OrgMembershipService,
          useValue: { revokeOrgScopedAccess },
        },
        { provide: InvitationLifecycleService, useValue: { revokeAllPending } },
      ],
    }).compile();
    service = moduleRef.get(OrgLifecycleService);
  });

  it("archives atomically, moves the active org, and evicts only org-scoped access", async () => {
    selectResults.push(
      [{ userId: "user-1" }],
      [{ orgId: "org-2" }],
    );

    await expect(service.archiveOrg("org-1", "user-1")).resolves.toEqual({
      success: true,
      nextOrgId: "org-2",
    });

    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(revokeAllPending).toHaveBeenCalledWith("org-1", db);
    expect(revokeOrgScopedAccess).toHaveBeenCalledWith("org-1", "user-1");
    expect(cacheInvalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
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
      [{ id: "org-1", name: "Alpha", slug: "alpha" }],
      [{ userId: "user-1" }],
      [{ orgId: "org-2" }],
    );

    await expect(
      service.deleteOrg("org-1", "user-1", "Alpha"),
    ).resolves.toEqual({ success: true, nextOrgId: "org-2" });

    expect(revokeOrgScopedAccess).toHaveBeenCalledWith("org-1", "user-1");
    expect(cacheInvalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
  });
});
