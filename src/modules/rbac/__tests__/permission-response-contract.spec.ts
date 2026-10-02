import { PERMISSIONS, UNIVERSAL_MEMBER_PERMISSION_GRANTS } from "../permissions";
import {
  permissionCatalogResponseSchema,
  permissionResponseSchema,
} from "../dto/rbac-response.schemas";
import { moduleCatalogResponseSchema } from "../../module-access/dto/module-access-response.schemas";
import { grantablePermissionsSchema } from "../../api-tokens/user/dto/user-api-tokens-response.schemas";

const SCOPE_BY_KEY = new Map<string, "own" | "all">(
  UNIVERSAL_MEMBER_PERMISSION_GRANTS.map((grant) => [grant.permissionKey, grant.scope]),
);

const DISCOVERABLE = PERMISSIONS.map((permission) => {
  const baselineScope = SCOPE_BY_KEY.get(permission.name);
  return baselineScope ? { ...permission, baselineScope } : permission;
});

const SENSITIVE = PERMISSIONS.filter((permission) => permission.sensitive);

describe("every catalogued permission satisfies the permission row response contract", () => {
  it("covers a non-empty catalogue that includes sensitive and baseline-scoped keys", () => {
    expect(PERMISSIONS.length).toBeGreaterThan(400);
    expect(SENSITIVE.length).toBeGreaterThan(0);
    expect(DISCOVERABLE.filter((permission) => "baselineScope" in permission).length).toBe(
      UNIVERSAL_MEMBER_PERMISSION_GRANTS.length,
    );
  });

  it.each(DISCOVERABLE.map((permission) => [permission.name, permission] as const))(
    "%s parses against the strict GET /rbac/permissions row schema",
    (_name, permission) => {
      expect(permissionResponseSchema.safeParse(permission).error).toBeUndefined();
    },
  );

  it("parses the whole discoverable catalogue as one GET /rbac/permissions response", () => {
    expect(permissionCatalogResponseSchema.safeParse(DISCOVERABLE).error).toBeUndefined();
  });

  it.each(SENSITIVE.map((permission) => [permission.name, permission] as const))(
    "%s keeps sensitive: true through every permission row contract",
    (_name, permission) => {
      expect(permissionResponseSchema.parse(permission).sensitive).toBe(true);
      expect(moduleCatalogResponseSchema.parse([permission])[0]?.sensitive).toBe(true);
      expect(grantablePermissionsSchema.parse([permission])[0]?.sensitive).toBe(true);
    },
  );

  it("rejects a sensitive flag that is anything but the literal true", () => {
    const [first] = SENSITIVE;
    expect(permissionResponseSchema.safeParse({ ...first, sensitive: false }).success).toBe(false);
    expect(permissionResponseSchema.safeParse({ ...first, sensitive: true }).success).toBe(true);
  });

  it("still rejects an undeclared field, so the sensitive declaration is what admits it", () => {
    const [first] = SENSITIVE;
    expect(permissionResponseSchema.safeParse({ ...first, undeclared: 1 }).success).toBe(false);
  });
});
