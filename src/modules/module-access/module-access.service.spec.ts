import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessService } from "./module-access.service";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "org-1",
    role: "MEMBER",
    permissions: [],
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    ...overrides,
  };
}

describe("ModuleAccessService", () => {
  let svc: ModuleAccessService;
  let resolveUserPermissions: jest.Mock;
  let mockDb: Record<string, jest.Mock | Record<string, unknown>>;

  beforeEach(async () => {
    jest.resetAllMocks();
    resolveUserPermissions = jest.fn().mockResolvedValue(new Map<string, string>());
    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      transaction: jest.fn(),
      query: { roles: { findFirst: jest.fn() } },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    svc = moduleRef.get(ModuleAccessService);
  });

  describe("assertModuleAccess", () => {
    it("rejects an unknown/unmanaged module with 404", async () => {
      await expect(
        svc.assertModuleAccess(actor({ isOrgOwner: true }), "billing", "view"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("allows the organization owner without a permission lookup", async () => {
      await expect(
        svc.assertModuleAccess(actor({ isOrgOwner: true }), "hr", "manage"),
      ).resolves.toBeUndefined();
      expect(resolveUserPermissions).not.toHaveBeenCalled();
    });

    it("allows an org admin (holds settings:rbac:manage)", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([["settings:rbac:manage", "all"]]),
      );
      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).resolves.toBeUndefined();
    });

    it("allows a module admin that holds <module>:access:<action>", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([["hr:access:manage", "all"]]),
      );
      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).resolves.toBeUndefined();
    });

    it("forbids a caller without the module access permission", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([["crm:access:manage", "all"]]),
      );
      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("moduleCatalog / listCatalog", () => {
    it("returns only the module's permissions", async () => {
      const catalog = await svc.listCatalog(actor({ isOrgOwner: true }), "hr");
      expect(catalog.length).toBeGreaterThan(0);
      expect(catalog.every((p) => p.name.split(":")[0] === "hr")).toBe(true);
      expect(catalog.some((p) => p.name === "hr:access:manage")).toBe(true);
    });
  });

  describe("setRolePermissions", () => {
    it("rejects a permission key outside the module namespace", async () => {
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "crm:leads:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to edit an organization-level system role", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "ORG_ADMIN", isSystem: true, moduleKey: null, version: 1, rank: 10, orgId: "org-1" },
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("lets a module-scoped system role through to the version check", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "HR_MODULE_ADMIN", isSystem: true, moduleKey: "hr", version: 2, rank: 20, orgId: "org-1" },
      );
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      };
      (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(txMock),
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("throws 404 when the role is not in the caller's org", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        undefined,
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 999, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws ConflictException when the CAS version is stale", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "CUSTOM_ROLE", isSystem: false, version: 2, rank: 40, moduleKey: "hr", orgId: "org-1" },
      );
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      };
      (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(txMock),
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("returns { success: true, version: N+1 } when the CAS version matches", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "CUSTOM_ROLE", isSystem: false, version: 1, rank: 40, moduleKey: "hr", orgId: "org-1" },
      );
      const txMock = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 5 }]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      };
      (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(txMock),
      );
      (mockDb as { invalidate?: jest.Mock }).invalidate = jest.fn().mockResolvedValue(undefined);

      const result = await svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
        version: 1,
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      });
      expect(result).toEqual({ success: true, version: 2 });
    });
  });
});
