import { permissions, rolePermissionGrants, roles } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import { ROLE_RANK } from "../../common/rbac/grantability";
import {
  ACCESS_MANAGED_MODULES,
  MODULE_ACCESS_PERMISSIONS,
  moduleScopedPermissions,
  ROLE_DEFAULT_PERMISSIONS,
} from "./permissions";

export const MODULE_ADMIN_MODULES: readonly string[] = Array.from(
  new Set<string>([...MODULE_CATALOG, ...ACCESS_MANAGED_MODULES]),
);

export async function resolveDbPermissionSet(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ name: permissions.name })
    .from(permissions)
    .limit(2000);
  return new Set(rows.map((r) => r.name));
}

export function buildOrgAdminPermissionKeys(dbCatalog: Set<string>): string[] {
  const accessKeys = MODULE_ACCESS_PERMISSIONS.map((p) => p.name);
  const candidates = [
    ...new Set([
      ...moduleScopedPermissions("settings"),
      "audit-log:read",
      "reports:view",
      "reports:export",
      "ownership:modules:view",
      "ownership:modules:manage",
      ...accessKeys,
    ]),
  ];
  return candidates.filter((key) => dbCatalog.has(key));
}

const MODULE_MEMBER_KEY_SCOPE_OVERRIDE: Record<string, "own" | "team" | "all"> =
  {
    "sign:envelope:view": "own",
  };

const MODULE_ADMIN_EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  hr: ["settings:view", "settings:organization:manage"],
  crm: ["settings:record-layouts:manage"],
  build: ["integrations:git:view", "integrations:git:manage"],
};

const MODULE_MEMBER_EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  hr: ["settings:view"],
};

export function buildModuleAdminPermissionKeys(
  moduleKey: string,
  dbCatalog: Set<string>,
): string[] {
  const extra = MODULE_ADMIN_EXTRA_KEYS[moduleKey] ?? [];
  return [...moduleScopedPermissions(moduleKey), ...extra].filter((key) =>
    dbCatalog.has(key),
  );
}

export function buildModuleMemberPermissionKeys(
  moduleKey: string,
  dbCatalog: Set<string>,
): string[] {
  const scoped = moduleScopedPermissions(moduleKey).filter(
    (key) => key.endsWith(":view") || key.endsWith(":read"),
  );
  const extra = MODULE_MEMBER_EXTRA_KEYS[moduleKey] ?? [];
  return [...scoped, ...extra].filter((key) => dbCatalog.has(key));
}

export function buildOrgMemberPermissionKeys(dbCatalog: Set<string>): string[] {
  return (ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []).filter((key) =>
    dbCatalog.has(key),
  );
}

export interface SeededRoleSpec {
  slug: string;
  name: string;
  rank: number;
  moduleKey: string | null;
  permissionKeys: string[];
}

export function buildSeededRoleSpecs(dbCatalog: Set<string>): SeededRoleSpec[] {
  return [
    {
      slug: "ORG_ADMIN",
      name: "Org Admin",
      rank: ROLE_RANK.ORG_ADMIN,
      moduleKey: null,
      permissionKeys: buildOrgAdminPermissionKeys(dbCatalog),
    },
    {
      slug: "MEMBER",
      name: "Member",
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
      permissionKeys: buildOrgMemberPermissionKeys(dbCatalog),
    },
    ...MODULE_ADMIN_MODULES.map((mod) => ({
      slug: `${mod.toUpperCase()}_MODULE_ADMIN`,
      name: `${mod.charAt(0).toUpperCase() + mod.slice(1)} Module Admin`,
      rank: ROLE_RANK.MODULE_ADMIN,
      moduleKey: mod as string | null,
      permissionKeys: buildModuleAdminPermissionKeys(mod, dbCatalog),
    })),
    ...ACCESS_MANAGED_MODULES.flatMap((mod) => [
      {
        slug: `${mod.toUpperCase()}_MODULE_OWNER`,
        name: `${mod.charAt(0).toUpperCase() + mod.slice(1)} Module Owner`,
        rank: ROLE_RANK.MODULE_OWNER,
        moduleKey: mod as string | null,
        permissionKeys: buildModuleAdminPermissionKeys(mod, dbCatalog),
      },
      {
        slug: `${mod.toUpperCase()}_MODULE_MEMBER`,
        name: `${mod.charAt(0).toUpperCase() + mod.slice(1)} Module Member`,
        rank: ROLE_RANK.MODULE_CUSTOM,
        moduleKey: mod as string | null,
        permissionKeys: buildModuleMemberPermissionKeys(mod, dbCatalog),
      },
    ]),
  ];
}

export function seededGrantScope(
  slug: string,
  permissionKey: string,
): "all" | "own" | "team" {
  if (!slug.endsWith("_MODULE_MEMBER")) return "all";
  return MODULE_MEMBER_KEY_SCOPE_OVERRIDE[permissionKey] ?? "all";
}

export async function seedSystemRolesForOrg(
  db: Db,
  orgId: string,
): Promise<{ created: number }> {
  const dbCatalog = await resolveDbPermissionSet(db);
  const specs = buildSeededRoleSpecs(dbCatalog);

  if (specs.length === 0) return { created: 0 };

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(roles)
      .values(
        specs.map((spec) => ({
          name: spec.name,
          slug: spec.slug,
          orgId,
          isSystem: true,
          rank: spec.rank,
          moduleKey: spec.moduleKey,
        })),
      )
      .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
      .returning({ id: roles.id, slug: roles.slug });

    if (inserted.length === 0) return { created: 0 };

    const specBySlug = new Map(specs.map((spec) => [spec.slug, spec]));
    const grants = inserted.flatMap((role) => {
      const spec = specBySlug.get(role.slug);
      if (!spec) return [];
      return spec.permissionKeys.map((permissionKey) => ({
        orgId,
        roleId: role.id,
        permissionKey,
        scope: seededGrantScope(spec.slug, permissionKey),
      }));
    });

    if (grants.length > 0)
      await tx
        .insert(rolePermissionGrants)
        .values(grants)
        .onConflictDoNothing();

    await bumpPermissionsVersion(tx, orgId);

    return { created: inserted.length };
  });
}
