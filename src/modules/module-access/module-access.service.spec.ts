import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ModuleAccessService,
  invalidateRoleAssigneePages,
} from "./module-access.service";
import { AccessService } from "../access/access.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

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

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  (chain.from as jest.Mock).mockReturnValue(chain);
  (chain.innerJoin as jest.Mock).mockReturnValue(chain);
  (chain.where as jest.Mock).mockReturnValue(chain);
  return chain;
}

describe("invalidateRoleAssigneePages", () => {
  it("continues invalidating after the first 500 assignees", async () => {
    const pages = Array.from({ length: 5 }, (_, pageIndex) =>
      Array.from({ length: 100 }, (_, rowIndex) => {
        const membershipId = pageIndex * 100 + rowIndex + 1;
        return { membershipId, userId: `user-${membershipId}` };
      }),
    );
    pages.push([
      { membershipId: 501, userId: "user-501" },
      { membershipId: 502, userId: "user-502" },
    ]);
    const fetchPage = jest.fn().mockImplementation(async () => pages.shift() ?? []);
    const invalidateSession = jest.fn().mockResolvedValue(undefined);

    await invalidateRoleAssigneePages(fetchPage, invalidateSession);

    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(invalidateSession).toHaveBeenCalledTimes(502);
    expect(invalidateSession).toHaveBeenCalledWith("user-502");
  });
});

describe("ModuleAccessService", () => {
  let svc: ModuleAccessService;
  let resolveUserPermissions: jest.Mock;
  let mockDb: Record<string, jest.Mock | Record<string, unknown>>;

  beforeEach(async () => {
    jest.resetAllMocks();
    resolveUserPermissions = jest.fn().mockResolvedValue(new Map<string, string>());
    mockDb = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      transaction: jest.fn(),
      query: {
        roles: { findFirst: jest.fn() },
        organizationMembers: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ isOwner: false, role: "MEMBER" }),
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleAccessService,
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

    it("allows a STRUCTURAL org admin, read from the membership row", async () => {
      (
        mockDb.query as { organizationMembers: { findFirst: jest.Mock } }
      ).organizationMembers.findFirst.mockResolvedValue({
        isOwner: false,
        role: "ORG_ADMIN",
      });

      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).resolves.toBeUndefined();
      expect(resolveUserPermissions).not.toHaveBeenCalled();
    });

    it("AC-04: a reserved permission key alone no longer confers org-admin authority", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([
          ["settings:manage", "all"],
          ["settings:rbac:manage", "all"],
        ]),
      );

      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("allows the actual module owner", async () => {
      (mockDb.select as jest.Mock)
        .mockReturnValueOnce(makeSelectChain([{ userId: "u1" }]))
        .mockReturnValueOnce(makeSelectChain([]));

      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).resolves.toBeUndefined();
    });

    it.each(["hr", "crm"])(
      "allows a directly assigned Module Admin for the requested %s module",
      async (moduleKey) => {
        (mockDb.select as jest.Mock)
          .mockReturnValueOnce(makeSelectChain([]))
          .mockReturnValueOnce(
            makeSelectChain([{ rank: 20, moduleKey }]),
          );

        await expect(
          svc.assertModuleAccess(actor(), moduleKey, "manage"),
        ).resolves.toBeUndefined();
      },
    );

    it("forbids a functional member even when an effective grant contains manage", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([["hr:access:manage", "all"]]),
      );
      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("forbids a Module Admin assigned only to another module", async () => {
      (mockDb.select as jest.Mock)
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(
          makeSelectChain([{ rank: 20, moduleKey: "crm" }]),
        );

      await expect(
        svc.assertModuleAccess(actor(), "hr", "manage"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("lets a module owner read their own module without holding the view key", async () => {
      (mockDb.select as jest.Mock)
        .mockReturnValueOnce(makeSelectChain([{ userId: "u1" }]))
        .mockReturnValueOnce(makeSelectChain([]));

      await expect(
        svc.assertModuleAccess(actor(), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("lets a module admin read their own module without holding the view key", async () => {
      (mockDb.select as jest.Mock)
        .mockReturnValueOnce(makeSelectChain([]))
        .mockReturnValueOnce(makeSelectChain([{ rank: 20, moduleKey: "hr" }]));

      await expect(
        svc.assertModuleAccess(actor(), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("still lets the view key alone grant read-only access administration", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map([["hr:access:view", "all"]]),
      );

      await expect(
        svc.assertModuleAccess(actor(), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("forbids a member with neither standing nor the view key", async () => {
      await expect(
        svc.assertModuleAccess(actor(), "hr", "view"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("lets a STRUCTURAL org admin read a module they hold no key for", async () => {
      (
        mockDb.query as { organizationMembers: { findFirst: jest.Mock } }
      ).organizationMembers.findFirst.mockResolvedValue({
        isOwner: false,
        role: "ORG_ADMIN",
      });

      await expect(
        svc.assertModuleAccess(actor(), "hr", "view"),
      ).resolves.toBeUndefined();
    });

    it("refuses Home outright, which is universal and has no access ladder", async () => {
      await expect(
        svc.assertModuleAccess(actor({ isOrgOwner: true }), "home", "view"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("moduleCatalog / listCatalog", () => {
    it("returns only the module's permissions", async () => {
      const catalog = await svc.listCatalog(actor({ isOrgOwner: true }), "hr");
      expect(catalog.length).toBeGreaterThan(0);
      expect(catalog.every((p) => p.name.split(":")[0] === "hr")).toBe(true);
      expect(catalog.some((p) => p.name === "hr:access:manage")).toBe(true);
    });

    it("has no catalog for Home, which is universal and administers no ladder", async () => {
      await expect(
        svc.listCatalog(actor({ isOrgOwner: true }), "home"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("getCallerPermissions", () => {
    it("reports nothing for Home, which has no access screen to report against", async () => {
      resolveUserPermissions.mockResolvedValue(
        new Map<string, string>([["chat:channels:read", "all"]]),
      );

      await expect(
        svc.getCallerPermissions(actor(), "home"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("reports org-level and module-level authority independently, since one person can hold both", async () => {
      (
        mockDb.query as { organizationMembers: { findFirst: jest.Mock } }
      ).organizationMembers.findFirst.mockResolvedValue({
        id: 1,
        isOwner: false,
        role: "ORG_ADMIN",
      });
      (mockDb.select as jest.Mock)
        .mockReturnValueOnce(makeSelectChain([{ userId: "u1" }]))
        .mockReturnValueOnce(makeSelectChain([]));

      const result = await svc.getCallerPermissions(actor(), "hr");

      expect(result).toMatchObject({ isOrgAdmin: true, isModuleOwner: true });
    });

    it("refuses someone who is not an active member", async () => {
      (
        mockDb.query as { organizationMembers: { findFirst: jest.Mock } }
      ).organizationMembers.findFirst.mockResolvedValue(undefined);

      await expect(
        svc.getCallerPermissions(actor(), "hr"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("setRolePermissions", () => {
    it("returns 404 when the role belongs to another module", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "CRM_CUSTOM", isSystem: false, version: 1, rank: 40, moduleKey: "crm", orgId: "org-1" },
      );

      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a permission key outside the module namespace", async () => {
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "crm:leads:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("hides organization-level system roles from module permission writes", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "ORG_ADMIN", isSystem: true, moduleKey: null, version: 1, rank: 10, orgId: "org-1" },
      );
      await expect(
        svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
          version: 1,
          items: [{ permissionKey: "hr:employees:view", scope: "all" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lets a module-scoped system role through to the version check", async () => {
      (mockDb.query as { roles: { findFirst: jest.Mock } }).roles.findFirst.mockResolvedValue(
        { id: 5, slug: "HR_MODULE_ADMIN", isSystem: true, moduleKey: "hr", version: 2, rank: 20, orgId: "org-1" },
      );
      const txMock = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        select: jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue([]),
                  }),
                }),
              }),
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
        execute: jest.fn().mockResolvedValue([]),
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
      const insertValues = jest.fn().mockResolvedValue([]);
      const txMock = {
        execute: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 5 }]),
            }),
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        select: jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      };
      (mockDb as { transaction: jest.Mock }).transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(txMock),
      );
      (mockDb as { invalidate?: jest.Mock }).invalidate = jest.fn().mockResolvedValue(undefined);

      const result = await svc.setRolePermissions(actor({ isOrgOwner: true }), "hr", 5, {
        version: 1,
        items: [{ permissionKey: "hr:employees:create", scope: "all" }],
      });
      expect(result).toEqual({ success: true, version: 2 });
      expect(insertValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            permissionKey: "hr:employees:view",
            scope: "all",
          }),
        ]),
      );
    });
  });
});
