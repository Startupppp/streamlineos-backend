import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessGroupsService } from "../module-access-groups.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    branchId: null,
    role: "MEMBER",
    permissions: [],
    enabledModules: [],
    plan: null,
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "s-1",
    ...overrides,
  };
}

function makeFlexChain(results: unknown[]) {
  const limitFn = jest.fn().mockResolvedValue(results);
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn().mockReturnValue({ limit: limitFn }),
    limit: limitFn,
  };
  chain.from!.mockReturnValue(chain);
  chain.innerJoin!.mockReturnValue(chain);
  return chain;
}

function buildSelectFn(resultSets: unknown[][]) {
  let callIndex = 0;
  return jest.fn().mockImplementation(() => {
    const results = resultSets[callIndex] ?? [];
    callIndex++;
    return makeFlexChain(results);
  });
}

function buildTxMock() {
  const valuesResult = {
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
    returning: jest.fn().mockResolvedValue([{ id: 9, name: "New Group", isSystem: false }]),
  };
  const insertChain = {
    values: jest.fn().mockReturnValue(valuesResult),
  };
  return {
    insert: jest.fn().mockReturnValue(insertChain),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
}

async function buildSvc(opts: {
  actorOverrides?: Partial<CurrentUserContext>;
  selectResultSets?: unknown[][];
  orgMember?: { id: number } | null;
  groupRow?: { id: number; orgId: string; moduleKey: string; isSystem: boolean } | null;
  permissionsMap?: Map<string, string>;
}) {
  const permissionsMap = opts.permissionsMap ?? new Map([["hr:access:manage", "all"]]);
  const selectResultSets = opts.selectResultSets ?? [[]];
  const orgMember = opts.orgMember !== undefined ? opts.orgMember : { id: 42 };
  const groupRow =
    opts.groupRow !== undefined
      ? opts.groupRow
      : { id: 9, orgId: "org-1", moduleKey: "hr", isSystem: false };

  const txMock = buildTxMock();
  const transaction = jest.fn().mockImplementation(
    async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  );

  const updateChain = {
    set: jest.fn(),
  };
  const setContinue = {
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([groupRow]),
      catch: jest.fn().mockReturnValue([groupRow]),
    }),
  };
  updateChain.set.mockReturnValue(setContinue);

  const mockDb = {
    select: buildSelectFn(selectResultSets),
    transaction,
    update: jest.fn().mockReturnValue(updateChain),
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(groupRow) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(orgMember) },
    },
  };

  const m = await Test.createTestingModule({
    providers: [
      ModuleAccessGroupsService,
      { provide: DRIZZLE, useValue: mockDb },
      { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(permissionsMap) } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();

  return { svc: m.get(ModuleAccessGroupsService), mockDb };
}

describe("ModuleAccessGroupsService — P0-1: self-assignment guard", () => {
  it("blocks a non-owner actor from adding themselves to a module group", async () => {
    const { svc } = await buildSvc({});

    await expect(
      svc.addGroupMember(makeActor({ userId: "u-actor" }), "hr", 9, { userId: "u-actor" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an org owner to add themselves to a module group", async () => {
    const { svc } = await buildSvc({
      actorOverrides: { isOrgOwner: true },
      selectResultSets: [[{ userId: "u-other-owner" }]],
    });

    const result = await svc.addGroupMember(
      makeActor({ userId: "u-actor", isOrgOwner: true }),
      "hr",
      9,
      { userId: "u-actor" },
    );

    expect(result).toEqual({ success: true });
  });

  it("allows a platform admin to add themselves to a module group", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-other-owner" }]],
    });

    const result = await svc.addGroupMember(
      makeActor({ userId: "u-actor", isPlatformAdmin: true }),
      "hr",
      9,
      { userId: "u-actor" },
    );

    expect(result).toEqual({ success: true });
  });
});

describe("ModuleAccessGroupsService — P0-2: module owner protection", () => {
  it("blocks a module admin from adding the module owner to a group", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-owner" }]],
    });

    await expect(
      svc.addGroupMember(makeActor({ userId: "u-admin" }), "hr", 9, { userId: "u-owner" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks a module admin from removing the module owner from a group", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-owner" }]],
    });

    await expect(
      svc.removeGroupMember(makeActor({ userId: "u-admin" }), "hr", 9, "u-owner"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows the module owner to remove themselves from a group", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-owner" }]],
      orgMember: { id: 42 },
    });

    const result = await svc.removeGroupMember(
      makeActor({ userId: "u-owner" }),
      "hr",
      9,
      "u-owner",
    );

    expect(result).toEqual({ success: true });
  });

  it("allows an org owner to remove the module owner from a group", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-owner" }]],
      orgMember: { id: 42 },
    });

    const result = await svc.removeGroupMember(
      makeActor({ userId: "u-org-owner", isOrgOwner: true }),
      "hr",
      9,
      "u-owner",
    );

    expect(result).toEqual({ success: true });
  });

  it("allows operations on non-owner users unaffected by the owner guard", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ userId: "u-owner" }]],
      orgMember: { id: 42 },
    });

    const result = await svc.removeGroupMember(
      makeActor({ userId: "u-admin" }),
      "hr",
      9,
      "u-regular-member",
    );

    expect(result).toEqual({ success: true });
  });
});

describe("ModuleAccessGroupsService — P0-3: duplicate group name guard", () => {
  it("rejects createGroup when a group with the same name (case-insensitive) already exists", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ id: 5 }]],
    });

    await expect(
      svc.createGroup(makeActor({ isOrgOwner: true }), "hr", { name: "Recruitment HR" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows createGroup when no group with that name exists in the module", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[]],
    });

    const result = await svc.createGroup(makeActor({ isOrgOwner: true }), "hr", {
      name: "New Group",
    });

    expect(result).toMatchObject({ id: 9, isSystem: false });
  });

  it("rejects renameGroup when the new name (differing only in case) already exists", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[{ id: 77 }]],
    });

    await expect(
      svc.renameGroup(makeActor({ isOrgOwner: true }), "hr", 9, { name: "RECRUITMENT HR" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows renameGroup to the same name as the current group (excludes self from check)", async () => {
    const { svc } = await buildSvc({
      selectResultSets: [[]],
    });

    const result = await svc.renameGroup(makeActor({ isOrgOwner: true }), "hr", 9, {
      name: "Existing Group Name",
    });

    expect(result).toBeDefined();
  });
});
