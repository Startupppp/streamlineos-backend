import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { CacheService } from "../../common/cache/cache.service";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { AccessService } from "../access/access.service";
import { RolePermissionService } from "./role-permission.service";

describe("RolePermissionService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROLE_ID = 9;

  function makeDb(roleRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(roleRow);
    return {
      query: { roles: { findFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
    } as unknown as Db;
  }

  it("throws NotFoundException when role belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockCache = stubService<CacheService>({ cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockAccess = stubService<AccessService>({ getPermissionsVersion: jest.fn().mockResolvedValue(1) });
    const svc = new RolePermissionService(db, mockCache, mockAudit, mockAccess);
    await expect(svc.getRolePermissions(ATTACKER, ROLE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns permissions for a role in the owning org (control — same-tenant)", async () => {
    const roleRow = { id: ROLE_ID, orgId: OWNER, name: "HR Admin", slug: "HR_ADMIN" };
    const db = makeDb(roleRow);
    const mockCache = stubService<CacheService>({ cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()) });
    const mockAudit = stubService<AuditService>({ log: jest.fn() });
    const mockAccess = stubService<AccessService>({ getPermissionsVersion: jest.fn().mockResolvedValue(1) });
    const svc = new RolePermissionService(db, mockCache, mockAudit, mockAccess);
    const result = await svc.getRolePermissions(OWNER, ROLE_ID);
    expect(Array.isArray(result)).toBe(true);
  });
});
