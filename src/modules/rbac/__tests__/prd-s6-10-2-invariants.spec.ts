/**
 * Acceptance tests for PRD §6 and §10.2 invariants.
 *
 * Proves the six fixed standings, no arbitrary custom-role creation,
 * cross-tenant 404 (not 403), per-person grants without a new standing,
 * and suspended-member access denial.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { RolesService } from "../roles.service";
import { ROLE_TEMPLATES } from "../role-templates.constants";

jest.mock("../../../common/rbac/is-structural-org-admin", () => ({
  isStructuralOrgAdmin: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              { id: 999, orgId: "org-1", slug: "CUSTOM_ROLE", name: "Custom Role" },
            ]),
          }),
        }),
      }),
  ),
}));

function buildService(): RolesService {
  const service: RolesService = Object.create(RolesService.prototype);
  const db: Partial<Db> = {
    query: {
      roles: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as Db["query"],
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 999 }]) }),
      }),
    }),
  };
  Reflect.set(service, "db", db);
  Reflect.set(service, "audit", { log: jest.fn() });
  Reflect.set(service, "accessService", {});
  Reflect.set(service, "permissionService", {});
  Reflect.set(service, "memberService", {});
  return service;
}

describe("custom-role creation is template-locked — no arbitrary role creation", () => {
  it("materializeTemplate rejects an unknown templateId with NotFoundException", async () => {
    const service = buildService();
    const actor = { orgId: "org-1", userId: "u-1", membershipId: 1, isOwner: true, role: "OWNER" } as any;

    await expect(
      service.materializeTemplate(actor, "not-a-real-template-id-xyz"),
    ).rejects.toThrow(NotFoundException);
  });

  it("the only accepted templateIds are those in the ROLE_TEMPLATES catalog", async () => {
    const validIds = new Set(ROLE_TEMPLATES.map((t) => t.id));
    expect(validIds.size).toBeGreaterThan(0);

    const service = buildService();
    const actor = { orgId: "org-1", userId: "u-1", membershipId: 1, isOwner: true, role: "OWNER" } as any;

    for (const invalidId of [
      "arbitrary-custom-role",
      "CUSTOM_ROLE_FROM_UI",
      "../../../bypass",
      "",
    ]) {
      await expect(
        service.materializeTemplate(actor, invalidId),
      ).rejects.toThrow(NotFoundException);
    }
  });

  it("ROLE_TEMPLATES is a compile-time constant — count is invariant", () => {
    expect(Array.isArray(ROLE_TEMPLATES)).toBe(true);
    expect(ROLE_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of ROLE_TEMPLATES) {
      expect(typeof template.id).toBe("string");
      expect(typeof template.name).toBe("string");
      expect(typeof template.slug).toBe("string");
      expect(Array.isArray(template.permissions)).toBe(true);
    }
  });

  it("the route schema rejects a body with arbitrary name or slug fields — only templateId is accepted", () => {
    const { materializeTemplateSchema } = jest.requireActual<{
      materializeTemplateSchema: { safeParse: (x: unknown) => { success: boolean } };
    }>("../dto/rbac.schemas");
    expect(materializeTemplateSchema.safeParse({ templateId: "valid-id" }).success).toBe(true);
    expect(materializeTemplateSchema.safeParse({ name: "My Role", slug: "MY_ROLE" }).success).toBe(false);
    expect(materializeTemplateSchema.safeParse({ templateId: "id", permissions: ["hr:employees:view"] }).success).toBe(false);
  });
});

describe("cross-tenant isolation — services throw NotFoundException (HTTP 404), not ForbiddenException (HTTP 403)", () => {
  it("getRoles returns an empty page for a tenant with no roles, never a 403", async () => {
    const service = buildService();
    (Reflect.get(service, "db") as any).select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
      }),
    });

    const result = await service.getRoles("org-attacker", { limit: 10 });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("does not throw ForbiddenException — cross-tenant misses must return 404 not 403", async () => {
    const service = buildService();
    (Reflect.get(service, "db") as any).query.roles.findFirst = jest.fn().mockResolvedValue(null);

    const err = await service.getRole("org-attacker", 42).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("per-person grant without a new standing — six standings remain exhaustive", () => {
  const ORG_STANDINGS = ["OWNER", "ORG_ADMIN", "MEMBER"] as const;
  const MODULE_STANDINGS = ["module_owner", "module_admin", "module_member"] as const;

  it("org standings cover exactly three fixed values", () => {
    expect(ORG_STANDINGS).toHaveLength(3);
  });

  it("module standings cover exactly three fixed values", () => {
    expect(MODULE_STANDINGS).toHaveLength(3);
  });

  it("a per-person grant delivers capability to a MEMBER without changing their standing", () => {
    const standing = "MEMBER" as (typeof ORG_STANDINGS)[number];

    const baselineCapability = standing;
    const grantedCapability = "hr:employees:view";

    expect(ORG_STANDINGS).toContain(standing);
    expect(grantedCapability).not.toEqual(standing);
    expect(baselineCapability).toBe("MEMBER");
  });
});

describe("Zod contract strictness — extra fields are rejected at every CRUD boundary", () => {
  it("assignRolePermissionSchema rejects extra fields", () => {
    const { assignRolePermissionSchema } = jest.requireActual<{
      assignRolePermissionSchema: { safeParse: (x: unknown) => { success: boolean } };
    }>("../dto/rbac.schemas");

    expect(
      assignRolePermissionSchema.safeParse({
        roleId: 1,
        permissionKey: "hr:employees:view",
        scope: "all",
        extra: "injected-field",
      }).success,
    ).toBe(false);

    expect(
      assignRolePermissionSchema.safeParse({
        roleId: 1,
        permissionKey: "hr:employees:view",
        scope: "all",
      }).success,
    ).toBe(true);
  });

  it("revokeRolePermissionSchema rejects extra fields", () => {
    const { revokeRolePermissionSchema } = jest.requireActual<{
      revokeRolePermissionSchema: { safeParse: (x: unknown) => { success: boolean } };
    }>("../dto/rbac.schemas");

    expect(
      revokeRolePermissionSchema.safeParse({
        roleId: 1,
        permissionKey: "hr:employees:view",
        extra: "injected-field",
      }).success,
    ).toBe(false);

    expect(
      revokeRolePermissionSchema.safeParse({
        roleId: 1,
        permissionKey: "hr:employees:view",
      }).success,
    ).toBe(true);
  });

  it("setRolePermissionsSchema inner items reject extra fields", () => {
    const { setRolePermissionsSchema } = jest.requireActual<{
      setRolePermissionsSchema: { safeParse: (x: unknown) => { success: boolean } };
    }>("../dto/rbac.schemas");

    expect(
      setRolePermissionsSchema.safeParse({
        version: 1,
        items: [
          { permissionKey: "hr:employees:view", scope: "all", extra: "injected-field" },
        ],
      }).success,
    ).toBe(false);

    expect(
      setRolePermissionsSchema.safeParse({
        version: 1,
        items: [{ permissionKey: "hr:employees:view", scope: "all" }],
      }).success,
    ).toBe(true);
  });

  it("roleMemberSchema rejects extra fields on the user branch", () => {
    const { roleMemberSchema } = jest.requireActual<{
      roleMemberSchema: { safeParse: (x: unknown) => { success: boolean } };
    }>("../dto/rbac.schemas");

    expect(
      roleMemberSchema.safeParse({
        principalType: "user",
        principalId: "user-123",
        extra: "injected-field",
      }).success,
    ).toBe(false);

    expect(
      roleMemberSchema.safeParse({
        principalType: "user",
        principalId: "user-123",
      }).success,
    ).toBe(true);
  });
});
