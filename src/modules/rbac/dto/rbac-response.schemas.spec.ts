import { ROLE_TEMPLATES } from "../role-templates.constants";
import { PERMISSIONS } from "../permissions";
import {
  accessSnapshotResponseSchema,
  discoveryGrantableResponseSchema,
  discoveryMembersResponseSchema,
  permissionCatalogResponseSchema,
  rolePermissionMutationResponseSchema,
  roleTemplateCatalogResponseSchema,
  seededRolesResponseSchema,
} from "./rbac-response.schemas";

describe("RBAC response contracts", () => {
  it("accepts the permission and template catalogs", () => {
    expect(permissionCatalogResponseSchema.safeParse(PERMISSIONS).success).toBe(true);
    expect(roleTemplateCatalogResponseSchema.safeParse(ROLE_TEMPLATES).success).toBe(true);
  });

  it("accepts access and grant-discovery responses", () => {
    expect(
      accessSnapshotResponseSchema.safeParse({
        scopes: { "chat:channels:read": "all" },
        modules: { home: true, payroll: false },
        isOrgOwner: false,
        canManageOrganizationMembership: true,
        mfa: { enforced: true, satisfied: true },
        version: 12,
      }).success,
    ).toBe(true);
    expect(
      discoveryGrantableResponseSchema.safeParse({
        grantableKeys: ["chat:channels:read"],
        assignableRanks: [30, 40],
        allowedModules: ["chat"],
      }).success,
    ).toBe(true);
  });

  it("accepts mutation, seed, and bounded member responses", () => {
    expect(rolePermissionMutationResponseSchema.safeParse({ success: true }).success).toBe(true);
    expect(
      seededRolesResponseSchema.safeParse({ created: ["HR_ADMIN"], skipped: [] }).success,
    ).toBe(true);
    expect(
      discoveryMembersResponseSchema.safeParse([
        { userId: "user-1", name: null, email: "member@example.com" },
      ]).success,
    ).toBe(true);
  });
});
