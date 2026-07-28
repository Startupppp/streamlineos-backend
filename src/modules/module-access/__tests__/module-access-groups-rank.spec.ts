import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessGroupsService } from "../module-access-groups.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "org-1",
    branchId: null,
    role: "MEMBER",
    permissions: [],
    enabledModules: [],
    plan: null,
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "s1",
    ...overrides,
  };
}

function buildSelectChain(resolvedRows: { rank: number; moduleKey: string | null }[]) {
  const limitMock = jest.fn().mockResolvedValue(resolvedRows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const innerJoin2 = jest.fn().mockReturnValue({ where: whereMock });
  const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2, where: whereMock });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
  return jest.fn().mockReturnValue({ from: fromMock });
}

function buildTxMock(createdRow: { id: number; name: string; isSystem: boolean }) {
  const valuesMock = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([createdRow]),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
  return { insert: insertMock, update: jest.fn() };
}

async function buildSvc(
  rankRows: { rank: number; moduleKey: string | null }[],
  permissionsMap: Map<string, string>,
  createdRow = { id: 1, name: "Test Group", isSystem: false },
) {
  const resolveUserPermissions = jest.fn().mockResolvedValue(permissionsMap);
  const txMock = buildTxMock(createdRow);
  const transaction = jest.fn().mockImplementation(
    async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  );

  const mockDb = {
    select: buildSelectChain(rankRows),
    insert: jest.fn(),
    transaction,
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(createdRow) },
    },
  };

  const m = await Test.createTestingModule({
    providers: [
      ModuleAccessGroupsService,
      { provide: DRIZZLE, useValue: mockDb },
      { provide: AccessService, useValue: { resolveUserPermissions } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
    ],
  }).compile();

  return { svc: m.get(ModuleAccessGroupsService), resolveUserPermissions, mockDb };
}

const MODULE_PERM_MAP = new Map([["hr:access:manage", "all"]]);
const ORG_ADMIN_PERM_MAP = new Map<string, string>([
  ["settings:rbac:manage", "all"],
  ["hr:access:manage", "all"],
]);

describe("ModuleAccessGroupsService.createGroup — rank check", () => {
  it("blocks an actor with MODULE_CUSTOM rank (30) from creating a group", async () => {
    const { svc } = await buildSvc(
      [{ rank: ROLE_RANK.MODULE_CUSTOM, moduleKey: "hr" }],
      MODULE_PERM_MAP,
    );

    await expect(svc.createGroup(actor(), "hr", { name: "Reviewers" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("blocks an actor with FUNCTIONAL rank (40) from creating a group", async () => {
    const { svc } = await buildSvc(
      [{ rank: ROLE_RANK.FUNCTIONAL, moduleKey: "hr" }],
      MODULE_PERM_MAP,
    );

    await expect(svc.createGroup(actor(), "hr", { name: "Reviewers" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows a MODULE_ADMIN (rank 20) actor for the same module to create a group", async () => {
    const { svc } = await buildSvc(
      [{ rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "hr" }],
      MODULE_PERM_MAP,
    );

    const result = await svc.createGroup(actor(), "hr", { name: "Reviewers" });

    expect(result).toMatchObject({ id: 1, name: "Test Group", isSystem: false, memberCount: 0, permissions: [] });
  });

  it("allows an org owner to create a group, bypassing rank check entirely", async () => {
    const { svc, resolveUserPermissions } = await buildSvc([], MODULE_PERM_MAP);

    const result = await svc.createGroup(actor({ isOrgOwner: true }), "hr", { name: "Admins" });

    expect(result).toBeDefined();
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("allows a platform admin to create a group, bypassing rank check entirely", async () => {
    const { svc, resolveUserPermissions } = await buildSvc([], MODULE_PERM_MAP);

    const result = await svc.createGroup(actor({ isPlatformAdmin: true }), "hr", { name: "Admins" });

    expect(result).toBeDefined();
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("allows an org admin (holds settings:rbac:manage) to create a group without querying rank", async () => {
    const { svc, mockDb } = await buildSvc([], ORG_ADMIN_PERM_MAP);

    const result = await svc.createGroup(actor(), "hr", { name: "Org Admin Group" });

    expect(result).toBeDefined();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
