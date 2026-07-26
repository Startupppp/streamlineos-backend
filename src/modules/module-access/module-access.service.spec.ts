import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessService } from "./module-access.service";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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
          items: [{ permissionKey: "crm:leads:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to edit a system role", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "HR_ADMIN", isSystem: true },
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws 404 when the role is not in the caller's org", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        undefined,
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 999, {
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
