import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RolePermissionService } from "../role-permission.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

const ownerActor: CurrentUserContext = {
  userId: "u1",
  orgId: "org-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
};

const baseRole = {
  id: 1,
  orgId: "org-1",
  isSystem: false,
  version: 1,
  rank: 40,
  moduleKey: null,
  slug: "CUSTOM_ROLE",
};

function makeTx(casReturns: Array<{ id: number }>) {
  return {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(casReturns),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    }),
  };
}

function makeDb(
  role: typeof baseRole | undefined,
  txMock: ReturnType<typeof makeTx>,
): Db {
  return {
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(role) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(txMock),
    ),
  } as unknown as Db;
}

function makeService(
  role: typeof baseRole | undefined,
  txMock: ReturnType<typeof makeTx>,
): RolePermissionService {
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  } as unknown as AccessService;
  return new RolePermissionService(makeDb(role, txMock), cache, audit, access);
}

describe("RolePermissionService.setRolePermissions — CAS", () => {
  it("throws ConflictException when the client version is stale (CAS returns 0 rows)", async () => {
    const svc = makeService(baseRole, makeTx([]));
    await expect(
      svc.setRolePermissions(ownerActor, 1, { version: 99, items: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns { success: true, version: N+1 } when version matches", async () => {
    const svc = makeService(baseRole, makeTx([{ id: 1 }]));
    const result = await svc.setRolePermissions(ownerActor, 1, {
      version: 1,
      items: [{ permissionKey: "hr:employees:view", scope: "all" }],
    });
    expect(result).toEqual({ success: true, version: 2 });
  });

  it("two sequential saves with the returned version both succeed", async () => {
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    } as unknown as AccessService;

    const firstTx = makeTx([{ id: 1 }]);
    const firstDb = makeDb({ ...baseRole, version: 1 }, firstTx);
    const svc1 = new RolePermissionService(firstDb, cache, audit, access);
    const result1 = await svc1.setRolePermissions(ownerActor, 1, { version: 1, items: [] });
    expect(result1).toEqual({ success: true, version: 2 });

    const secondTx = makeTx([{ id: 1 }]);
    const secondDb = makeDb({ ...baseRole, version: result1.version }, secondTx);
    const svc2 = new RolePermissionService(secondDb, cache, audit, access);
    const result2 = await svc2.setRolePermissions(ownerActor, 1, { version: result1.version, items: [] });
    expect(result2).toEqual({ success: true, version: 3 });
  });

  it("throws NotFoundException when the role does not exist", async () => {
    const svc = makeService(undefined, makeTx([]));
    await expect(
      svc.setRolePermissions(ownerActor, 999, { version: 1, items: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws ForbiddenException for system roles before reaching the CAS", async () => {
    const systemRole = { ...baseRole, isSystem: true };
    const svc = makeService(systemRole, makeTx([]));
    await expect(
      svc.setRolePermissions(ownerActor, 1, { version: 1, items: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
