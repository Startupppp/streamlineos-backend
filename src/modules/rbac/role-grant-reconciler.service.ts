import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../common/tenant/with-tenant";
import { forEachOrg } from "../../common/tenant/for-each-org";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { rolePermissionGrants, roles } from "../../db/schema";
import { ROLE_TEMPLATES } from "./role-templates.constants";
import {
  systemRoleSpecs,
  resolveDbPermissionSet,
  scopeForGrant,
} from "./seed-system-roles";

const ROLE_PAGE_SIZE = 200;
const GRANT_PAGE_SIZE = 1000;
const INSERT_CHUNK_SIZE = 500;

type GrantScope = "all" | "own" | "team";

/**
 * What every reconcilable slug is supposed to hold, given a permission catalog.
 *
 * Pure and exported because it is the whole answer to "is this template widening
 * inert for organisations that already exist" — a key present here for a slug
 * that exists reaches every pristine role at the next boot, and a key absent
 * here reaches nobody. `backfill-slugs-exist.spec.ts` asserts against it rather
 * than against the service, so the claim is checked instead of narrated.
 */
export function buildDesiredGrants(
  catalog: ReadonlySet<string>,
): Map<string, DesiredGrant[]> {
  const desired = new Map<string, DesiredGrant[]>();

  for (const spec of systemRoleSpecs(new Set(catalog))) {
    if (spec.permissionKeys.length === 0) continue;
    desired.set(
      spec.slug,
      spec.permissionKeys.map((permissionKey) => ({
        permissionKey,
        scope: scopeForGrant(spec.slug, permissionKey),
      })),
    );
  }

  for (const template of ROLE_TEMPLATES) {
    const keys = template.permissions.filter((key) => catalog.has(key));
    if (keys.length === 0) continue;
    desired.set(
      template.slug,
      keys.map((permissionKey) => ({ permissionKey, scope: "all" as const })),
    );
  }

  return desired;
}

export interface ReconcileReport {
  organizations: number;
  rolesReconciled: number;
  grantsInserted: number;
  rolesSkippedAsAdministered: number;
}

interface DesiredGrant {
  permissionKey: string;
  scope: GrantScope;
}

/**
 * Brings the grant rows of every *pristine* seeded or template-materialised role
 * up to what the seeder and `ROLE_TEMPLATES` would produce today.
 *
 * It exists because a SQL migration structurally cannot do this job.
 * `role_permission_grants.permission_key` carries a foreign key to
 * `permissions.name`, and `permissions` is filled by
 * `PermissionCatalogSyncService` at boot — after `db:migrate`. A backfill
 * migration for a key introduced in the same release therefore finds no catalog
 * row, its `EXISTS` guard skips the key, and nothing re-runs afterwards. Every
 * template widening inherited that, and `0990` is the instance that reached zero
 * rows in every organisation.
 *
 * Pristine means `roles.version = 1`: no administrator has ever written this
 * role's permissions. Every administrative grant path advances that counter, so
 * a role somebody has narrowed on purpose leaves this population permanently and
 * a revoked key can never be resurrected. Roles nobody has touched keep
 * converging, which is the invariant `MODULE_ADMIN_EXTRA_KEYS` already states:
 * a newly seeded organisation and a backfilled one must resolve identically.
 */
@Injectable()
export class RoleGrantReconcilerService {
  private readonly logger = new Logger(RoleGrantReconcilerService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async reconcileAllOrganizations(): Promise<ReconcileReport> {
    const desired = await this.buildDesiredGrants();
    const report: ReconcileReport = {
      organizations: 0,
      rolesReconciled: 0,
      grantsInserted: 0,
      rolesSkippedAsAdministered: 0,
    };
    if (desired.size === 0) return report;

    const slugs = [...desired.keys()];
    const sweep = await forEachOrg(this.db, "rbac-grant-reconcile", async (tx, orgId) => {
      const orgReport = await this.reconcileOrganization(tx, orgId, desired, slugs);
      report.rolesReconciled += orgReport.rolesReconciled;
      report.grantsInserted += orgReport.grantsInserted;
      report.rolesSkippedAsAdministered += orgReport.rolesSkippedAsAdministered;
    });
    report.organizations = sweep.organizations;

    this.logger.log(
      `Role grant reconcile: ${report.organizations} organisation(s), ${report.grantsInserted} grant(s) inserted across ${report.rolesReconciled} role(s); ${report.rolesSkippedAsAdministered} role(s) left alone because an administrator has written their permissions`,
    );
    return report;
  }

  private async buildDesiredGrants(): Promise<Map<string, DesiredGrant[]>> {
    return buildDesiredGrants(await resolveDbPermissionSet(this.db));
  }

  private async reconcileOrganization(
    tx: TenantTx,
    orgId: string,
    desired: Map<string, DesiredGrant[]>,
    slugs: readonly string[],
  ): Promise<Omit<ReconcileReport, "organizations">> {
    const candidates = await this.drainCandidateRoles(tx, orgId, slugs);
    const pristine = candidates.filter((role) => role.version === 1);
    const skipped = candidates.length - pristine.length;
    if (pristine.length === 0)
      return { rolesReconciled: 0, grantsInserted: 0, rolesSkippedAsAdministered: skipped };

    const roleIds = pristine.map((role) => role.id);
    const held = await this.drainHeldGrantKeys(tx, orgId, roleIds);

    const missing: { orgId: string; roleId: number; permissionKey: string; scope: GrantScope }[] = [];
    const touchedRoles = new Set<number>();
    for (const role of pristine) {
      const heldKeys = held.get(role.id);
      for (const grant of desired.get(role.slug) ?? []) {
        if (heldKeys?.has(grant.permissionKey) === true) continue;
        missing.push({
          orgId,
          roleId: role.id,
          permissionKey: grant.permissionKey,
          scope: grant.scope,
        });
        touchedRoles.add(role.id);
      }
    }

    if (missing.length === 0)
      return { rolesReconciled: 0, grantsInserted: 0, rolesSkippedAsAdministered: skipped };

    let inserted = 0;
    for (let offset = 0; offset < missing.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = missing.slice(offset, offset + INSERT_CHUNK_SIZE);
      const rows = await tx
        .insert(rolePermissionGrants)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: rolePermissionGrants.id });
      inserted += rows.length;
    }

    if (inserted > 0) await bumpPermissionsVersion(tx, orgId);

    return {
      rolesReconciled: touchedRoles.size,
      grantsInserted: inserted,
      rolesSkippedAsAdministered: skipped,
    };
  }

  private async drainCandidateRoles(
    tx: TenantTx,
    orgId: string,
    slugs: readonly string[],
  ): Promise<{ id: number; slug: string; version: number }[]> {
    const drained: { id: number; slug: string; version: number }[] = [];
    let afterId = 0;
    for (;;) {
      const page: { id: number; slug: string; version: number }[] = await tx
        .select({ id: roles.id, slug: roles.slug, version: roles.version })
        .from(roles)
        .where(
          and(
            eq(roles.orgId, orgId),
            inArray(roles.slug, [...slugs]),
            gt(roles.id, afterId),
          ),
        )
        .orderBy(asc(roles.id))
        .limit(ROLE_PAGE_SIZE);
      drained.push(...page);
      const last = page[page.length - 1];
      if (page.length < ROLE_PAGE_SIZE || last === undefined) return drained;
      afterId = last.id;
    }
  }

  private async drainHeldGrantKeys(
    tx: TenantTx,
    orgId: string,
    roleIds: readonly number[],
  ): Promise<Map<number, Set<string>>> {
    const held = new Map<number, Set<string>>();
    let afterId = 0;
    for (;;) {
      const page: { id: number; roleId: number; permissionKey: string }[] = await tx
        .select({
          id: rolePermissionGrants.id,
          roleId: rolePermissionGrants.roleId,
          permissionKey: rolePermissionGrants.permissionKey,
        })
        .from(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, orgId),
            inArray(rolePermissionGrants.roleId, [...roleIds]),
            gt(rolePermissionGrants.id, afterId),
          ),
        )
        .orderBy(asc(rolePermissionGrants.id))
        .limit(GRANT_PAGE_SIZE);
      for (const row of page) {
        const keys = held.get(row.roleId) ?? new Set<string>();
        keys.add(row.permissionKey);
        held.set(row.roleId, keys);
      }
      const last = page[page.length - 1];
      if (page.length < GRANT_PAGE_SIZE || last === undefined) return held;
      afterId = last.id;
    }
  }
}
