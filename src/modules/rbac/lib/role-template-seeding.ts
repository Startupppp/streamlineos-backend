import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { rolePermissionGrants, roles } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../../common/rbac/is-structural-org-admin";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { seedSystemRolesForOrg } from "../seed-system-roles";
import { ROLE_TEMPLATES, type RoleTemplate } from "../role-templates.constants";
import { PERMISSIONS } from "../permissions";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));

/**
 * Materialising role rows from the FIXED catalog.
 *
 * Nothing here is caller-supplied: the caller names a template id and the name,
 * slug, rank and permission list all come from ROLE_TEMPLATES, so there is
 * nothing for an actor to escalate and none of this consults grantability —
 * that is the whole reason it is separate from lib/role-mutation.ts, which
 * exists to police caller-supplied permission keys. The only gate that applies
 * is structural: materializeTemplate needs org owner or admin standing.
 *
 * Every path is idempotent on (orgId, template.slug): seedDefaultRoles reports
 * an already-present template as skipped and materializeTemplate returns the
 * existing row, so re-running either never re-grants permissions an owner has
 * since revoked. Keys the catalog no longer defines are filtered out rather
 * than inserted, because a stale template entry must not create a grant for a
 * permission that no longer exists.
 */
export interface RoleTemplateSeedingDeps {
  readonly db: Db;
}

export async function seedDefaultRoles(
  deps: RoleTemplateSeedingDeps,
  orgId: string,
) {
  await seedSystemRolesForOrg(deps.db, orgId);

  const starterTemplateIds = [
    "engineering",
    "sales_rep",
    "customer_support",
    "digital_marketing",
    "hr_admin",
    "accountant",
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const templateId of starterTemplateIds) {
    const template = ROLE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) continue;
    const existing = await deps.db.query.roles.findFirst({
      where: and(eq(roles.slug, template.slug), eq(roles.orgId, orgId)),
      columns: { id: true },
    });
    if (existing) {
      skipped.push(template.slug);
      continue;
    }
    await seedFromTemplate(deps, orgId, template);
    created.push(template.slug);
  }
  return { created, skipped };
}

/**
 * Materialises a FIXED catalog template. The caller names a template id and
 * nothing else — name, slug and permissions come from the template — so this
 * is not custom-role creation, which is why it survives while `createRole` did not.
 */
export async function materializeTemplate(
  deps: RoleTemplateSeedingDeps,
  actor: CurrentUserContext,
  templateId: string,
): Promise<typeof roles.$inferSelect> {
  if (!(await isStructuralOrgAdmin(deps.db, actor)))
    throw new ForbiddenException(
      "Only an organization owner or administrator may add a role",
    );

  const template = ROLE_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new NotFoundException("Role template not found");

  const existing = await deps.db.query.roles.findFirst({
    where: and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)),
  });
  if (existing) return existing;

  await seedFromTemplate(deps, actor.orgId, template);
  const [created] = await deps.db
    .select()
    .from(roles)
    .where(and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)))
    .limit(1);
  if (!created) throw new ConflictException("Role template could not be created");
  return created;
}

async function seedFromTemplate(
  deps: RoleTemplateSeedingDeps,
  orgId: string,
  template: RoleTemplate,
): Promise<void> {
  const validPermissions = template.permissions.filter((k) => CATALOG_KEYS.has(k));
  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const [row] = await tx
        .insert(roles)
        .values({
          name: template.name,
          slug: template.slug,
          orgId,
          isSystem: false,
          rank: ROLE_RANK.FUNCTIONAL,
          moduleKey: null,
        })
        .returning();

      if (validPermissions.length > 0) {
        await tx.insert(rolePermissionGrants).values(
          validPermissions.map((permissionKey) => ({
            orgId,
            roleId: row.id,
            permissionKey,
            scope: "all" as const,
          })),
        );
      }

      await bumpPermissionsVersion(tx, orgId);
    },
    { orgId },
  );
}
