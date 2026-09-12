import { permissions, rolePermissionGrants, roles } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { ACCESS_MANAGED_MODULES, MODULE_ACCESS_PERMISSIONS, moduleScopedPermissions, ROLE_DEFAULT_PERMISSIONS } from "./permissions";

/**
 * Every module with a ladder needs an admin rung, but `MODULE_CATALOG` also
 * decides plan gating: a key whose module sits there resolves to NO_MODULE
 * unless the organisation has it enabled. Deriving the admin rung from the union
 * keeps the two questions apart, so a module can be delegatable without becoming
 * plan-gated — which for mail and calendar would 403 every route they own.
 */
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

/**
 * Keys that module members receive at a narrower scope than the default "all".
 * Consulted only when inserting grants for MODULE_MEMBER roles, so admin-rung
 * roles are unaffected. Add an entry here whenever a module's view key is
 * scopable and new orgs should default members to "own" or "team".
 */
const MODULE_MEMBER_KEY_SCOPE_OVERRIDE: Record<string, "own" | "team" | "all"> = {
  "sign:envelope:view": "own",
  // A commission earning is somebody's pay. Without this entry a newly seeded
  // CRM member would receive the key at "all" while migration 0545 backfills
  // existing organisations at "own" — divergence by signup date, and in the
  // direction where the new tenants are the ones leaking salaries.
  "crm:commission-earnings:view": "own",
  // A timesheets module member is a person who logs time, not one who
  // supervises it. Every scopable timesheets view key would otherwise be
  // seeded at "all" and hand each member the organisation's entries, approval
  // queue, payroll period summaries, reports and exception queue; the
  // non-scopable keys the generic member rung grants are a product decision
  // recorded in docs/timesheets-signos-final-handoff.md.
  "timesheets:entries:view": "own",
  "timesheets:team:view": "own",
  "timesheets:approvals:view": "own",
  "timesheets:reports:view": "own",
  "timesheets:payroll:view": "own",
  "timesheets:exceptions:view": "own",
};

/**
 * Keys a module's admins need that live outside their own namespace.
 *
 * `settings:record-layouts:manage` is a `settings:` key, so `ORG_ADMIN` receives
 * it through `buildOrgAdminPermissionKeys` already — but every record type it
 * can arrange is a CRM or Party one, and a CRM administrator who cannot arrange
 * a CRM list would have to borrow organisation administration to move a column.
 * Named here rather than only in the backfill, so a newly seeded organisation
 * and a backfilled one resolve to the same capability; migration 0226 exists
 * because that invariant was broken once already.
 *
 * `integrations:git:*` is the same shape for Build. Repository connections are
 * the Build module's own settings page (`/build/settings/integrations`) and
 * `git_connections.project_id` points at a Build project, but the keys sit in
 * the `integrations` namespace, so `moduleScopedPermissions("build")` skips
 * them. Until this entry existed the page was gated on `settings:manage` —
 * organisation administration — and a `BUILD_MODULE_ADMIN` could not open their
 * own module's integrations. The pair is deliberately narrow: it reaches
 * repository connections and nothing else in `integrations`, and `RoleGrantReconciler`
 * delivers it to organisations that already exist.
 */
const MODULE_ADMIN_EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  hr: ["settings:view"],
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
  return (ROLE_DEFAULT_PERMISSIONS["MEMBER"] ?? []).filter((key) => dbCatalog.has(key));
}

export interface SeededRoleSpec {
  readonly slug: string;
  readonly name: string;
  readonly rank: number;
  readonly moduleKey: string | null;
  readonly permissionKeys: string[];
}

/**
 * Every system role a new organisation gets, decided without touching the
 * database, and the only definition of what each seeded slug is supposed to
 * hold.
 *
 * Pure and exported so the shape of the ladder can be asserted directly, rather
 * than inferred from how many times an insert mock was called.
 * `RoleGrantReconcilerService` reads this same function
 * so an organisation seeded before a rung was widened converges on what a fresh
 * one gets — the invariant `MODULE_ADMIN_EXTRA_KEYS` states and that migration
 * 0226 exists because it was broken once.
 */
export function systemRoleSpecs(dbCatalog: Set<string>): SeededRoleSpec[] {
  const specs: SeededRoleSpec[] = [
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

  const bySlug = new Map(specs.map((spec) => [spec.slug, spec]));
  return [...bySlug.values()];
}


/**
 * `MODULE_MEMBER_KEY_SCOPE_OVERRIDE` applies only to the member rung, so the
 * scope a grant is seeded at is a function of the slug and the key. Exported so
 * the reconciler seats a backfilled grant at the same scope the seeder would.
 */
export function scopeForGrant(slug: string, permissionKey: string): "own" | "team" | "all" {
  if (!slug.endsWith("_MODULE_MEMBER")) return "all";
  return MODULE_MEMBER_KEY_SCOPE_OVERRIDE[permissionKey] ?? "all";
}


/**
 * How many grant rows go in one statement.
 *
 * Four columns per row, so this is nowhere near Postgres' 65535 bound; it is
 * small enough that a chunk stays a comfortable packet and large enough that the
 * ~1400 grants a fresh organisation needs cost two statements rather than
 * fourteen hundred.
 */
const GRANT_CHUNK = 1000;

/**
 * Every system role and every one of its grants, in one transaction.
 *
 * This used to open **one transaction per role** -- 41 of them, each costing
 * BEGIN, an insert, an insert, a version bump and COMMIT. Against Neon that is
 * upwards of two hundred network round trips, which is where self-serve signup's
 * minute-plus provisioning came from: the work is trivial, the latency is not.
 * Batched it is a handful of statements, so a claim can finish inside the
 * request rather than behind a gateway timeout.
 *
 * One transaction is also the stronger correctness story. Per-role transactions
 * left a crash halfway through as an organisation with some of its ladder and no
 * record of which part -- exactly the half-provisioned tenant the flow is
 * supposed to make impossible. Now it is all of the roles or none of them.
 *
 * The invariant `seed-system-roles.spec.ts` pins is unchanged and is why grants
 * are keyed off the insert's own `RETURNING`: only a role this call created gets
 * grants, so re-seeding an organisation never restores a permission its owner
 * deliberately revoked.
 */
export async function seedSystemRolesForOrg(
  db: Db,
  orgId: string,
): Promise<{ created: number }> {
  const dbCatalog = await resolveDbPermissionSet(db);
  const specs = systemRoleSpecs(dbCatalog);

  return db.transaction(async (tx) => {
    /*
     * Untargeted `DO NOTHING`, where this once named the slug index. `roles`
     * carries a second unique index on (org, module, lower(name)), and a
     * conflict there raised 23505 instead of being skipped -- survivable when
     * each role had its own transaction, fatal to the whole ladder now that they
     * share one. Skipping on any conflict is what idempotent was always meant to
     * mean here.
     */
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
      .onConflictDoNothing()
      .returning({ id: roles.id, slug: roles.slug });

    if (inserted.length === 0) return { created: 0 };

    const createdIdBySlug = new Map(inserted.map((row) => [row.slug, row.id]));
    const grants = specs.flatMap((spec) => {
      const roleId = createdIdBySlug.get(spec.slug);
      if (roleId === undefined) return [];
      return spec.permissionKeys.map((permissionKey) => ({
        orgId,
        roleId,
        permissionKey,
        scope: scopeForGrant(spec.slug, permissionKey),
      }));
    });

    for (let at = 0; at < grants.length; at += GRANT_CHUNK) {
      await tx
        .insert(rolePermissionGrants)
        .values(grants.slice(at, at + GRANT_CHUNK))
        .onConflictDoNothing();
    }

    // Once, not once per role: the version is a cache epoch, and bumping it
    // forty-one times invalidated the same caches forty-one times.
    await bumpPermissionsVersion(tx, orgId);

    return { created: inserted.length };
  });
}
