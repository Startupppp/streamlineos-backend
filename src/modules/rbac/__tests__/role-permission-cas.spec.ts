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
  permissions: [],
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

function makeService(
  role: typeof baseRole | undefined,
  txMock: ReturnType<typeof makeTx>,
): RolePermissionService {
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
  } as unknown as AccessService;
  const db = {
    query: {
      roles: { findFirst: jest.fn().mockResolvedValue(role) },
    },
    transaction: jest.fn().mockImplementation(
      (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(txMock),
    ),
  } as unknown as Db;
  return new RolePermissionService(db, cache, audit, access);
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
    const firstDb = {
      query: { roles: { findFirst: jest.fn().mockResolvedValue({ ...baseRole, version: 1 }) } },
      transaction: jest.fn().mockImplementation(
        (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(firstTx),
      ),
    } as unknown as Db;
    const svc1 = new RolePermissionService(firstDb, cache, audit, access);
    const result1 = await svc1.setRolePermissions(ownerActor, 1, { version: 1, items: [] });
    expect(result1).toEqual({ success: true, version: 2 });

    const secondTx = makeTx([{ id: 1 }]);
    const secondDb = {
      query: { roles: { findFirst: jest.fn().mockResolvedValue({ ...baseRole, version: result1.version }) } },
      transaction: jest.fn().mockImplementation(
        (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(secondTx),
      ),
    } as unknown as Db;
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
