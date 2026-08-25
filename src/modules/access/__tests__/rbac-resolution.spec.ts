import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { AccessService } from "../access.service";
import {
  ALL_PERMISSION_NAMES,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
  moduleScopedPermissions,
} from "../../rbac/permissions";
import type { DataScope } from "../access.types";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";
import { isCoreModuleKey } from "../entitlements.service";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";
import { CATALOG_MODULES } from "../access-policy";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OwnershipTransfersService } from "../../ownership/ownership-transfers.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";

type AccessSelectChain = {
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
};

function makeSelectChain(result: unknown[]): AccessSelectChain {
  const chain: AccessSelectChain = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue(result),
    innerJoin: jest.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

type OwnershipSelectChain = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  for: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  orderBy: jest.Mock;
  returning: jest.Mock;
};

function makeOwnershipSelectChain(result: unknown[]): OwnershipSelectChain {
  const chain: OwnershipSelectChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
    for: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    orderBy: jest.fn(),
    returning: jest.fn().mockResolvedValue(result),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.for.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const ACTIVE_MEMBER_BASELINE_PERMISSIONS = new Set([
  ...UNIVERSAL_MEMBER_PERMISSIONS,
  ...(ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []),
]);

function expectActiveMemberBaseline(
  resolvedPermissions: Map<string, DataScope>,
): void {
  for (const permissionKey of ACTIVE_MEMBER_BASELINE_PERMISSIONS) {
    expect(resolvedPermissions.has(permissionKey)).toBe(true);
  }
  expect(new Set(resolvedPermissions.keys()).size).toBe(
    resolvedPermissions.size,
  );
}

function withTenantTransactionMock<T extends object>(database: T): T {
  const mutableDatabase = database as T & {
    execute?: jest.Mock;
    transaction?: jest.Mock;
  };
  if (typeof mutableDatabase.transaction !== "function") {
    mutableDatabase.execute = jest.fn().mockResolvedValue(undefined);
    mutableDatabase.transaction = jest
      .fn()
      .mockImplementation(
        async (transactionWork: (transactionDatabase: T) => Promise<unknown>) =>
          transactionWork(database),
      );
  }
  return database;
}

function buildService(db: unknown): AccessService {
  const cache = {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const allEnabled: Record<string, boolean> = {};
  for (const key of CATALOG_MODULES) allEnabled[key] = true;
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn((moduleKey: string) => isCoreModuleKey(moduleKey)),
    getModuleMap: jest.fn().mockResolvedValue(allEnabled),
    buildModuleAvailabilityResolver: jest.fn().mockImplementation(
      (
        getMap: (orgId: string) => Promise<Record<string, boolean>>,
        getDenied?: (orgId: string, userId: string) => Promise<Set<string>>,
      ) =>
        moduleAvailabilityResolver(
          { isCoreModule: isCoreModuleKey, getModuleMap: getMap, getPlanLockedModules: async () => [] },
          getDenied ? { getUserDeniedModules: getDenied } : undefined,
        ),
    ),
  };
  return new AccessService(
    withTenantTransactionMock(db as object) as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
  );
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER = "user-1";

describe("AccessService.resolveUserPermissions — org owner receives every catalog permission", () => {
  it("returns a non-empty map containing all catalog keys at all-scope, short-circuiting permission table reads", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: true, status: "ACTIVE", id: 1 }),
        },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const result = new Map(
      Object.entries(
        await (buildService(db) as unknown as {
          computeUserPermissions: (
            orgId: string,
            userId: string,
          ) => Promise<Record<string, "all" | "team" | "own" | "none">>;
        }).computeUserPermissions(ORG_A, USER),
      ),
    );

    expect(result.size).toBeGreaterThan(0);
    for (const name of ALL_PERMISSION_NAMES) {
      expect(result.has(name)).toBe(true);
    }
    expect(result.get("hr:employees:view")).toBe("all");
    expect(result.get("crm:leads:view")).toBe("all");
    expect(result.get("ownership:org:transfer")).toBe("all");
  });
});

describe("AccessService.getAccessSnapshot — org owner receives every catalog permission without querying permission tables", () => {
  it("returns all catalog keys in scopes and marks every module enabled, bypassing resolveUserPermissions entirely", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (work: (tx: typeof db) => Promise<unknown>) => work(db),
    );

    const ctx: CurrentUserContext = {
      userId: USER,
      orgId: ORG_A,
      role: "OWNER",
      isOrgOwner: true,
      sessionId: "session-owner",
      tokenScopes: null,
    };

    const svc = buildService(db);
    const snapshot = await svc.getAccessSnapshot(ORG_A, USER, ctx);

    expect(Object.keys(snapshot.scopes).length).toBeGreaterThan(0);
    expect(snapshot.scopes).toHaveProperty("hr:employees:view");
    expect(snapshot.scopes).toHaveProperty("crm:leads:view");
    expect(snapshot.scopes).toHaveProperty("ownership:org:transfer");
    expect(snapshot.scopes["hr:leaves:approve"]).toBe("all");
    expect(snapshot.scopes["hr:employees:view"]).toBe("all");
    expect(snapshot.isOrgOwner).toBe(true);
    expect(snapshot.canManageOrganizationMembership).toBe(true);
    expect(Object.keys(snapshot.modules).length).toBeGreaterThan(0);
    expect(Object.values(snapshot.modules).every((enabled) => enabled === true)).toBe(true);
    expect(db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("AccessService.resolveUserPermissions — ORG_ADMIN role grants every catalog permission", () => {
  it("resolves all catalog keys when the member holds the ORG_ADMIN role (defaulted from ROLE_DEFAULT_PERMISSIONS)", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({
            isOwner: false,
            status: "ACTIVE",
            role: "ORG_ADMIN",
            id: 1,
          }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 99 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 99, slug: "ORG_ADMIN" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = new Map(
      Object.entries(
        await (buildService(db) as unknown as {
          computeUserPermissions: (
            orgId: string,
            userId: string,
          ) => Promise<Record<string, "all" | "team" | "own" | "none">>;
        }).computeUserPermissions(ORG_A, USER),
      ),
    );

    expect(result.size).toBeGreaterThan(0);
    for (const name of ALL_PERMISSION_NAMES) {
      expect(result.has(name)).toBe(true);
    }
    expect(result.get("ownership:org:transfer")).toBe("all");
    expect(result.get("hr:leaves:approve")).toBe("all");
    expect(result.get("crm:deals:read")).toBe("all");
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("AccessService.resolveUserPermissions — module owner access", () => {
  it("grants the owned module plus universal member capabilities", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 2 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ moduleKey: "hr" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_A, USER);

    const hrKeys = new Set(moduleScopedPermissions("hr"));
    expect(hrKeys.size).toBeGreaterThan(0);
    expectActiveMemberBaseline(result);

    for (const key of hrKeys) {
      expect(result.get(key)).toBe("all");
    }

    expect(result.get("kb:pages:view")).toBe("all");
    expect(result.get("self:onboarding-docs")).toBe("own");

    expect(result.has("crm:leads:view")).toBe(false);
    expect(result.has("ownership:org:transfer")).toBe(false);
  });
});

describe("AccessService.resolveUserPermissions — member with a single role inherits exactly that role's DB grants", () => {
  it("grants only the two DB-configured keys: their presence and the absence of all other keys are both asserted", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 3 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 10 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 10, slug: "CUSTOM_HR_VIEWER" }]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 10, permissionKey: "hr:employees:view", scope: "own" },
          { roleId: 10, permissionKey: "hr:leaves:view", scope: "own" },
        ]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_A, USER);

    expectActiveMemberBaseline(result);
    expect(result.get("hr:employees:view")).toBe("own");
    expect(result.get("hr:leaves:view")).toBe("own");

    expect(result.has("hr:leaves:approve")).toBe(false);
    expect(result.has("hr:payroll:view")).toBe(false);
    expect(result.has("crm:leads:view")).toBe(false);
    expect(result.has("ownership:org:transfer")).toBe(false);
  });
});

describe("AccessService.resolveUserPermissions — member with two role sources: allow-wins union, no deny rules", () => {
  it("picks the broadest scope when the same key appears in both a direct role (own) and a group role (all)", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 4 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 20 }]))
        .mockReturnValueOnce(makeSelectChain([{ principalGroupId: "g-1" }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ roleId: 21 }]))
        .mockReturnValueOnce(makeSelectChain([
          { id: 20, slug: "CUSTOM_OWN" },
          { id: 21, slug: "CUSTOM_ALL" },
        ]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 20, permissionKey: "hr:employees:view", scope: "own" },
          { roleId: 21, permissionKey: "hr:employees:view", scope: "all" },
          { roleId: 21, permissionKey: "hr:leaves:view", scope: "all" },
        ]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_A, USER);

    expectActiveMemberBaseline(result);
    expect(result.get("hr:employees:view")).toBe("all");
    expect(result.get("hr:leaves:view")).toBe("all");

    expect(result.has("hr:leaves:approve")).toBe(false);
    expect(result.has("crm:leads:view")).toBe(false);
  });
});

describe("AccessService.resolveUserPermissions — member with no role assignments", () => {
  it("returns the intended self-service baseline for an active member", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 5 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_A, USER);

    expectActiveMemberBaseline(result);
  });
});

describe("AccessService.resolveUserPermissions — cross-tenant isolation: org A membership grants no permissions in org B", () => {
  it("returns an empty permission map when the user has no membership row in the target org", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_B, USER);

    expect(result.size).toBe(0);
  });
});

describe("AccessService.resolveUserPermissions — HEADLINE: a \"Recruitment HR\" module role group grants recruitment access and is DENIED hr:leaves:approve", () => {
  it("resolves interview, requisition and offer permissions but does NOT contain hr:leaves:approve", async () => {
    const db = {
      query: {
        accessVersions: { findFirst: jest.fn().mockResolvedValue(undefined) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 6 }),
        },
      },
      select: jest.fn()
        .mockReturnValueOnce(makeSelectChain([{ roleId: 30 }]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ id: 30, slug: "RECRUITMENT_HR" }]))
        .mockReturnValueOnce(makeSelectChain([
          { roleId: 30, permissionKey: "hr:interviews:view", scope: "all" },
          { roleId: 30, permissionKey: "hr:interviews:manage", scope: "all" },
          { roleId: 30, permissionKey: "hr:requisitions:view", scope: "all" },
          { roleId: 30, permissionKey: "hr:requisitions:manage", scope: "all" },
          { roleId: 30, permissionKey: "hr:offers:view", scope: "all" },
          { roleId: 30, permissionKey: "hr:offers:manage", scope: "all" },
          { roleId: 30, permissionKey: "hr:employees:view", scope: "all" },
        ]))
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([])),
    };

    const result = await buildService(db).resolveUserPermissions(ORG_A, USER);

    expectActiveMemberBaseline(result);
    expect(result.has("hr:interviews:view")).toBe(true);
    expect(result.has("hr:interviews:manage")).toBe(true);
    expect(result.has("hr:requisitions:view")).toBe(true);
    expect(result.has("hr:requisitions:manage")).toBe(true);
    expect(result.has("hr:offers:view")).toBe(true);
    expect(result.has("hr:offers:manage")).toBe(true);
    expect(result.has("hr:employees:view")).toBe(true);

    expect(result.has("hr:leaves:approve")).toBe(false);
    expect(result.has("hr:leaves:manage")).toBe(false);
    expect(result.has("hr:attendance:manage")).toBe(false);
    expect(result.has("hr:payroll:view")).toBe(false);
    expect(result.has("hr:salary:manage")).toBe(false);

  });
});

describe("OwnershipTransfersService.initiateOrgTransfer — org admin (isOwner=false) is denied at the service layer", () => {
  let svc: OwnershipTransfersService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnershipTransfersService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn().mockResolvedValue(undefined), invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = moduleRef.get(OwnershipTransfersService);
  });

  it("throws ForbiddenException for a non-owner actor even if ADMIN role grants them ownership:org:transfer in their permission map", async () => {
    const actorMembership = { id: 1, userId: "user-admin", isOwner: false, status: "ACTIVE" };
    mockDb.select.mockReturnValue(makeOwnershipSelectChain([actorMembership]));

    await expect(
      svc.initiateOrgTransfer("org-1", "user-admin", { toMembershipId: 2, expiresInHours: 24 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
