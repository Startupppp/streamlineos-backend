import { permissions, rolePermissionGrants, roles } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { ACCESS_MANAGED_MODULES, MODULE_ACCESS_PERMISSIONS, moduleScopedPermissions, ROLE_DEFAULT_PERMISSIONS } from "./permissions";

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

const PEOPLE_ADMIN_MODULE = "hr";
const PEOPLE_ADMIN_KEYS = ["settings:view", "settings:organization:manage"];
const PEOPLE_READ_KEYS = ["settings:view"];

export function buildModuleAdminPermissionKeys(
  moduleKey: string,
  dbCatalog: Set<string>,
): string[] {
  const extra = moduleKey === PEOPLE_ADMIN_MODULE ? PEOPLE_ADMIN_KEYS : [];
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
  const extra = moduleKey === PEOPLE_ADMIN_MODULE ? PEOPLE_READ_KEYS : [];
  return [...scoped, ...extra].filter((key) => dbCatalog.has(key));
}

export function buildOrgMemberPermissionKeys(dbCatalog: Set<string>): string[] {
  return (ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []).filter((key) => dbCatalog.has(key));
}

export async function seedSystemRolesForOrg(
  db: Db,
  orgId: string,
): Promise<{ created: number }> {
  const dbCatalog = await resolveDbPermissionSet(db);

  const specs: Array<{
    slug: string;
    name: string;
    rank: number;
    moduleKey: string | null;
    permissionKeys: string[];
  }> = [
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
    ...MODULE_CATALOG.map((mod) => ({
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

  let created = 0;
  for (const spec of specs) {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(roles)
        .values({
          name: spec.name,
          slug: spec.slug,
          orgId,
          isSystem: true,
          rank: spec.rank,
          moduleKey: spec.moduleKey,
        })
        .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
        .returning({ id: roles.id });

      if (inserted.length > 0) {
        created += 1;
        const row = inserted[0];
        if (row && spec.permissionKeys.length > 0) {
          await tx
            .insert(rolePermissionGrants)
            .values(
              spec.permissionKeys.map((permissionKey) => ({
                orgId,
                roleId: row.id,
                permissionKey,
                scope: "all" as const,
              })),
            )
            .onConflictDoNothing();
        }
        await bumpPermissionsVersion(tx, orgId);
      }
    });
  }

  return { created };
}
