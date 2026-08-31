import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { UserPermissionGrantsService } from "../user-permission-grants.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const txCalls = {
  deletes: 0,
  inserted: [] as Record<string, unknown>[],
  versionBumped: 0,
};

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<void>) =>
    fn({
      delete: () => ({ where: () => { txCalls.deletes += 1; return Promise.resolve(); } }),
      insert: () => ({
        values: (rows: Record<string, unknown>[]) => {
          txCalls.inserted.push(...rows);
          return Promise.resolve();
        },
      }),
    }),
}));

const rankContextHolder = {
  value: { bestRank: 40, allowedModules: null as Set<string> | null },
};

jest.mock("../module-access.helpers", () => ({
  resolveActorRankContext: () => Promise.resolve(rankContextHolder.value),
}));

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: () => {
    txCalls.versionBumped += 1;
    return Promise.resolve();
  },
}));

const ORG = "org-1";
const ACTOR: CurrentUserContext = {
  orgId: ORG,
  userId: "u-admin",
  isOrgOwner: false,
} as CurrentUserContext;

type Deps = {
  member?: { id: number; userId: string; status: string } | null;
  actorMember?: { id: number } | null;
  resolved?: Map<string, string>;
  rankContext?: { bestRank: number; allowedModules: Set<string> | null };
  manageThrows?: Error;
};

function build(deps: Deps) {
  const findFirst = jest.fn(async (args: { columns?: Record<string, boolean> }) => {
    if (args.columns && "userId" in args.columns)
      return deps.member === undefined
        ? { id: 7, userId: "u-target", status: "ACTIVE" }
        : deps.member;
    return deps.actorMember === undefined ? { id: 3 } : deps.actorMember;
  });

  const db = {
    query: { organizationMembers: { findFirst } },
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as unknown as Db;

  const moduleAccess = {
    assertModuleAccess: jest.fn(async () => {
      if (deps.manageThrows) throw deps.manageThrows;
    }),
  };
  const access = {
    resolveUserPermissions: jest.fn(async () =>
      deps.resolved ?? new Map([["hr:employees:view", "all"], ["hr:employees:manage", "all"]]),
    ),
  };
  const audit = { log: jest.fn() };
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const cache = { invalidate: cacheInvalidate };

  rankContextHolder.value = deps.rankContext ?? {
    bestRank: 40,
    allowedModules: null,
  };

  const service = new UserPermissionGrantsService(
    db,
    moduleAccess as never,
    access as never,
    audit as never,
    cache as never,
  );

  return { service, moduleAccess, access, audit, findFirst, cacheInvalidate };
}

beforeEach(() => {
  txCalls.deletes = 0;
  txCalls.inserted = [];
  txCalls.versionBumped = 0;
});

describe("attaching capability to one person", () => {
  it("writes the requested grants and nothing else", async () => {
    const { service } = build({});
    const result = await service.setGrants(ACTOR, "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });

    expect(result).toEqual({ success: true, granted: 1 });
    expect(txCalls.inserted).toHaveLength(1);
    expect(txCalls.inserted[0]).toMatchObject({
      orgId: ORG,
      organizationMembershipId: 7,
      permissionKey: "hr:employees:view",
      moduleKey: "hr",
    });
  });

  it("never touches a role, so granting does not change the person's standing", async () => {
    const { service } = build({});
    await service.setGrants(ACTOR, "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });

    const wroteToARoleTable = txCalls.inserted.some((row) =>
      Object.keys(row).some((column) => column.toLowerCase().includes("role")),
    );
    expect(wroteToARoleTable).toBe(false);
  });

  it("removes a grant again", async () => {
    const { service } = build({});
    await expect(
      service.removeGrant(ACTOR, "hr", 7, "hr:employees:view"),
    ).resolves.toEqual({ success: true });
    expect(txCalls.deletes).toBe(1);
  });

  it("replaces only this module's grants, leaving other modules untouched", async () => {
    const { service } = build({});
    await service.setGrants(ACTOR, "hr", 7, { items: [] });
    expect(txCalls.deletes).toBe(1);
    expect(txCalls.inserted).toHaveLength(0);
  });
});

describe("a grantor may only give away what their own standing carries", () => {
  it("refuses a key the grantor does not hold", async () => {
    const { service } = build({ resolved: new Map([["hr:employees:view", "all"]]) });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:manage", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(txCalls.inserted).toHaveLength(0);
  });

  it("refuses a key outside the module named in the route", async () => {
    const { service } = build({});
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "crm:leads:view", scope: "all" }],
      }),
    ).rejects.toThrow(/not part of the hr module/);
  });

  it("refuses a module admin granting outside their own module", async () => {
    const { service } = build({
      resolved: new Map([["crm:leads:view", "all"]]),
      rankContext: { bestRank: 20, allowedModules: new Set(["crm"]) },
    });
    await expect(
      service.setGrants(ACTOR, "crm", 7, {
        items: [{ permissionKey: "crm:leads:view", scope: "all" }],
      }),
    ).resolves.toMatchObject({ success: true });

    const other = build({
      resolved: new Map([["hr:employees:view", "all"]]),
      rankContext: { bestRank: 20, allowedModules: new Set(["crm"]) },
    });
    await expect(
      other.service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses someone without module-management standing before reading anything", async () => {
    const { service, access } = build({
      manageThrows: new ForbiddenException("nope"),
    });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("refuses a grantor trying to widen their own access", async () => {
    const { service } = build({
      member: { id: 7, userId: ACTOR.userId, status: "ACTIVE" },
    });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:manage", scope: "all" }],
      }),
    ).rejects.toThrow(/cannot grant permissions to yourself/);
  });
});

describe("a grantor cannot hand out a wider scope than their own", () => {
  it("refuses `all` from a grantor who only holds `team`", async () => {
    const { service } = build({
      resolved: new Map([["hr:employees:view", "team"]]),
    });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(txCalls.inserted).toHaveLength(0);
  });

  it("allows a scope at or below the grantor's own", async () => {
    const { service } = build({
      resolved: new Map([["hr:employees:view", "team"]]),
    });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "own" }],
      }),
    ).resolves.toMatchObject({ success: true });
    expect(txCalls.inserted[0]).toMatchObject({ scope: "own" });
  });

  it("still lets an org owner grant the broadest scope", async () => {
    const owner = { ...ACTOR, isOrgOwner: true } as CurrentUserContext;
    const { service } = build({
      resolved: new Map([["hr:employees:view", "own"]]),
    });
    await expect(
      service.setGrants(owner, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).resolves.toMatchObject({ success: true });
  });
});

describe("a suspended person can be audited and cleared, never widened", () => {
  it("refuses to grant to a member who is not active", async () => {
    const { service } = build({
      member: { id: 7, userId: "u-target", status: "SUSPENDED" },
    });
    await expect(
      service.setGrants(ACTOR, "hr", 7, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(txCalls.inserted).toHaveLength(0);
    expect(txCalls.deletes).toBe(0);
  });

  it("still revokes a grant left behind on a suspended member", async () => {
    const { service } = build({
      member: { id: 7, userId: "u-target", status: "SUSPENDED" },
    });
    await expect(
      service.removeGrant(ACTOR, "hr", 7, "hr:employees:view"),
    ).resolves.toEqual({ success: true });
    expect(txCalls.deletes).toBe(1);
  });

  it("still lists what a suspended member holds", async () => {
    const { service } = build({
      member: { id: 7, userId: "u-target", status: "SUSPENDED" },
    });
    await expect(service.listGrants(ACTOR, "hr", 7)).resolves.toEqual({
      grants: [],
    });
  });
});

describe("tenant isolation", () => {
  it("cannot reference a person outside the grantor's organisation", async () => {
    const { service } = build({ member: null });
    await expect(
      service.setGrants(ACTOR, "hr", 999, {
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(txCalls.inserted).toHaveLength(0);
  });
});

describe("revocation takes effect without re-authenticating", () => {
  it("bumps the permissions version inside the same transaction as the write", async () => {
    const { service } = build({});
    await service.setGrants(ACTOR, "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });
    expect(txCalls.versionBumped).toBe(1);

    txCalls.versionBumped = 0;
    await service.removeGrant(ACTOR, "hr", 7, "hr:employees:view");
    expect(txCalls.versionBumped).toBe(1);
  });
});

describe("the change is explainable afterwards", () => {
  it("records who granted what to whom", async () => {
    const { service, audit } = build({});
    await service.setGrants(ACTOR, "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      reason: "covering payroll month-end",
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "access.user_permission_grants_set",
        userId: "u-admin",
        orgId: ORG,
        resourceId: "7",
        metadata: expect.objectContaining({
          moduleKey: "hr",
          targetUserId: "u-target",
          permissionKeys: ["hr:employees:view"],
        }),
      }),
    );
  });

  it("records a removal too", async () => {
    const { service, audit } = build({});
    await service.removeGrant(ACTOR, "hr", 7, "hr:employees:view");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "access.user_permission_grant_removed",
        metadata: expect.objectContaining({ permissionKey: "hr:employees:view" }),
      }),
    );
  });
});

describe("platform billing stays out of reach", () => {
  it("refuses a billing key even to a grantor who holds it", async () => {
    const { service } = build({
      resolved: new Map([["billing:subscription:manage", "all"]]),
    });
    await expect(
      service.setGrants(ACTOR, "billing", 7, {
        items: [{ permissionKey: "billing:subscription:manage", scope: "all" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("target user session is invalidated so their next request re-resolves", () => {
  it("invalidates the target user session after setGrants", async () => {
    const { service, cacheInvalidate } = build({});
    await service.setGrants(ACTOR, "hr", 7, {
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });
    expect(cacheInvalidate).toHaveBeenCalledWith(
      expect.stringContaining("u-target"),
    );
  });

  it("invalidates the target user session after removeGrant", async () => {
    const { service, cacheInvalidate } = build({});
    await service.removeGrant(ACTOR, "hr", 7, "hr:employees:view");
    expect(cacheInvalidate).toHaveBeenCalledWith(
      expect.stringContaining("u-target"),
    );
  });
});
