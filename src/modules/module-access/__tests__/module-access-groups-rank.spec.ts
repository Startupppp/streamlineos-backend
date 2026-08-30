jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessGroupsService } from "../module-access-groups.service";
import { ModuleAccessGroupCrudService } from "../module-access-group-crud.service";
import { ModuleAccessGroupMembersService } from "../module-access-group-members.service";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

function makeChain(rows: unknown[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const innerJoin2 = jest.fn().mockReturnValue({ where: whereMock });
  const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2, where: whereMock });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1, where: whereMock });
  return { from: fromMock };
}

function buildSelectChain(
  resolvedRows: { rank: number; moduleKey: string | null }[],
  ownerUserId: string | null,
) {
  const selectFn = jest.fn();
  // Structural manage gate: ownership lookup, exact Module Admin lookup.
  selectFn.mockImplementationOnce(() =>
    makeChain(ownerUserId === null ? [] : [{ userId: ownerUserId }]),
  );
  selectFn.mockImplementationOnce(() => makeChain(resolvedRows));
  // Grantability then resolves the actor's rank independently.
  selectFn.mockImplementationOnce(() => makeChain(resolvedRows));
  selectFn.mockImplementation(() => makeChain([]));
  return selectFn;
}

function buildTxMock(createdRow: { id: number; name: string; isSystem: boolean }) {
  const valuesMock = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([createdRow]),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  });
  const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
  return {
    execute: jest.fn().mockResolvedValue([]),
    insert: insertMock,
    update: jest.fn(),
  };
}

async function buildSvc(
  rankRows: { rank: number; moduleKey: string | null }[],
  permissionsMap: Map<string, string>,
  createdRow = { id: 1, name: "Test Group", isSystem: false },
  ownerUserId: string | null = null,
  orgMemberRole: "MEMBER" | "ORG_ADMIN" = "MEMBER",
) {
  const resolveUserPermissions = jest.fn().mockResolvedValue(permissionsMap);
  const txMock = buildTxMock(createdRow);
  const transaction = jest.fn().mockImplementation(
    async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  );

  const mockDb = {
    select: buildSelectChain(rankRows, ownerUserId),
    insert: jest.fn(),
    transaction,
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(createdRow) },
      organizationMembers: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ isOwner: false, role: orgMemberRole }),
      },
    },
  };

  const m = await Test.createTestingModule({
    providers: [
      ModuleAccessGroupsService,
      ModuleAccessGroupCrudService,
      ModuleAccessGroupMembersService,
      ModuleAccessGroupPolicyService,
      { provide: DRIZZLE, useValue: mockDb },
      {
        provide: AccessService,
        useValue: {
          resolveUserPermissions,
          isModuleEnabled: jest.fn().mockResolvedValue(true),
        },
      },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      { provide: AuditService, useValue: { log: jest.fn() } },
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

  it("allows the canonical Module Owner to create a group", async () => {
    const { svc } = await buildSvc(
      [{ rank: ROLE_RANK.MODULE_OWNER, moduleKey: "hr" }],
      MODULE_PERM_MAP,
      undefined,
      "u1",
    );

    const result = await svc.createGroup(actor(), "hr", { name: "Reviewers" });

    expect(result).toMatchObject({ id: 1, name: "Test Group" });
  });

  it("allows an org owner to create a group, bypassing rank check entirely", async () => {
    const { svc, resolveUserPermissions } = await buildSvc([], MODULE_PERM_MAP);

    const result = await svc.createGroup(actor({ isOrgOwner: true }), "hr", { name: "Admins" });

    expect(result).toBeDefined();
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });


  it("allows a STRUCTURAL org admin to create a group without querying rank", async () => {
    const { svc, mockDb } = await buildSvc(
      [],
      MODULE_PERM_MAP,
      undefined,
      null,
      "ORG_ADMIN",
    );

    const result = await svc.createGroup(actor(), "hr", { name: "Org Admin Group" });

    expect(result).toBeDefined();
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("AC-04: holding settings:rbac:manage without an ORG_ADMIN membership row does NOT bypass the rank check", async () => {
    const { svc } = await buildSvc(
      [{ rank: ROLE_RANK.FUNCTIONAL, moduleKey: "hr" }],
      ORG_ADMIN_PERM_MAP,
    );

    await expect(
      svc.createGroup(actor(), "hr", { name: "Escalation Attempt" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
