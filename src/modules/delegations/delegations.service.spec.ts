import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import type { CacheService } from "../../common/cache/cache.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import {
  userDelegationPermissions,
  userDelegations,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import { DelegationsService } from "./delegations.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, work: (tx: unknown) => Promise<unknown>) => work(_db),
  ),
}));
jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(true),
}));

const actor = {
  userId: "delegator-1",
  orgId: "org-1",
  role: "OWNER",
  permissions: [],
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
} satisfies CurrentUserContext;

describe("DelegationsService normalized permission grants", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes lifecycle data to the header and permissions to child rows", async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000);
    const created = {
      id: "delegation-1",
      orgId: actor.orgId,
      delegatorId: actor.userId,
      delegateeId: "delegatee-1",
      startsAt,
      endsAt,
      reason: null,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
      revokedBy: null,
    };
    const headerValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([created]),
    });
    const permissionValues = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
        },
      },
      insert: jest.fn((table: unknown) => ({
        values:
          table === userDelegations ? headerValues : permissionValues,
      })),
    };
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new DelegationsService(
      db as unknown as Db,
      cache as unknown as CacheService,
      access as unknown as AccessService,
    );

    const result = await service.create(actor, {
      delegateeId: "delegatee-1",
      permissions: ["hr:employees:view", "hr:employees:manage"],
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });

    expect(headerValues).toHaveBeenCalledWith(
      expect.not.objectContaining({ permissions: expect.anything() }),
    );
    expect(permissionValues).toHaveBeenCalledWith([
      {
        orgId: actor.orgId,
        delegationId: created.id,
        permissionKey: "hr:employees:view",
      },
      {
        orgId: actor.orgId,
        delegationId: created.id,
        permissionKey: "hr:employees:manage",
      },
    ]);
    expect(result).toEqual({
      ...created,
      permissions: ["hr:employees:view", "hr:employees:manage"],
    });
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(db, actor.orgId);
    expect(cache.invalidate).toHaveBeenCalledWith(
      CACHE_KEYS.userSession("delegatee-1"),
    );
    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("hydrates API-compatible permission collections and participant names", async () => {
    const row = {
      id: "delegation-1",
      orgId: actor.orgId,
      delegatorId: actor.userId,
      delegateeId: "delegatee-1",
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-12T00:00:00.000Z"),
      reason: null,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
      revokedBy: null,
    };
    const select = jest.fn((selection?: Record<string, unknown>) => {
      if (!selection) {
        return {
          from: () => ({ where: jest.fn().mockResolvedValue([row]) }),
        };
      }
      if ("delegationId" in selection) {
        return {
          from: () => ({
            where: () => ({
              orderBy: jest.fn().mockResolvedValue([
                {
                  delegationId: row.id,
                  permissionKey: "hr:employees:view",
                },
              ]),
            }),
          }),
        };
      }
      return {
        from: () => ({
          where: jest.fn().mockResolvedValue([
            { id: actor.userId, name: "Alex Admin", email: "alex@example.com" },
            { id: row.delegateeId, name: null, email: "sam@example.com" },
          ]),
        }),
      };
    });
    const db = { select };
    const service = new DelegationsService(
      db as unknown as Db,
      {} as CacheService,
      {} as AccessService,
    );

    await expect(service.listGiven(actor.orgId, actor.userId)).resolves.toEqual([
      {
        ...row,
        permissions: ["hr:employees:view"],
        delegatorName: "Alex Admin",
        delegateeName: "sam@example.com",
      },
    ]);
    expect(select).toHaveBeenCalledTimes(3);
    expect(select).toHaveBeenCalledWith({
      delegationId: userDelegationPermissions.delegationId,
      permissionKey: userDelegationPermissions.permissionKey,
    });
  });
});
