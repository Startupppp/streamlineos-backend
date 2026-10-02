import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { rolePermissionGrants, roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { seedSystemRolesForOrg } from "./seed-system-roles";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import { PERMISSIONS } from "./permissions";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));

/**
 * Materialising role rows from the FIXED catalog.
 *
 * Nothing here is caller-supplied: the caller names a template id and the name,
 * slug, rank and permission list all come from ROLE_TEMPLATES, so there is
 * nothing for an actor to escalate and none of this consults grantability —
 * that is why it is separate from lib/role-mutation.ts, which exists to police
 * caller-supplied permission keys. The only gate that applies is structural:
 * materializeTemplate needs org owner or admin standing.
 *
 * Both paths are idempotent on (orgId, template.slug): seedDefaultRoles reports
 * an already-present template as skipped and materializeTemplate returns the
 * existing row, so re-running either never re-grants permissions an owner has
 * since revoked. Keys the catalog no longer defines are filtered out rather
 * than inserted, because a stale template entry must not create a grant for a
 * permission that no longer exists.
 */
@Injectable()
export class RoleSeedService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listTemplates(): readonly RoleTemplate[] {
    return ROLE_TEMPLATES;
  }

  async seedDefaultRoles(orgId: string) {
    await seedSystemRolesForOrg(this.db, orgId);

    const starterTemplateIds = [
      "engineering",
      "sales_rep",
      "customer_support",
      "digital_marketing",
      "hr_admin",
      "accountant",
    ];

    const templates = starterTemplateIds
      .map((id) => ROLE_TEMPLATES.find((t) => t.id === id))
      .filter((t): t is RoleTemplate => t !== undefined);

    if (templates.length === 0) return { created: [], skipped: [] };

    const slugs = templates.map((t) => t.slug);
    const existingRows = await this.db
      .select({ slug: roles.slug })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), inArray(roles.slug, slugs)));
    const existingSlugs = new Set(existingRows.map((r) => r.slug));

    const toCreate = templates.filter((t) => !existingSlugs.has(t.slug));
    const skipped = templates.filter((t) => existingSlugs.has(t.slug)).map((t) => t.slug);

    if (toCreate.length === 0) return { created: [], skipped };

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const roleRows = await tx
          .insert(roles)
          .values(
            toCreate.map((t) => ({
              name: t.name,
              slug: t.slug,
              orgId,
              isSystem: false,
              rank: ROLE_RANK.FUNCTIONAL,
              moduleKey: null,
            })),
          )
          .returning({ id: roles.id, slug: roles.slug });

        const permValues = roleRows.flatMap((row) => {
          const template = toCreate.find((t) => t.slug === row.slug);
          if (!template) return [];
          return template.permissions
            .filter((k) => CATALOG_KEYS.has(k))
            .map((permissionKey) => ({
              orgId,
              roleId: row.id,
              permissionKey,
              scope: "all" as const,
            }));
        });

        if (permValues.length > 0)
          await tx.insert(rolePermissionGrants).values(permValues);

        await commitAccessChange(tx, orgId);
      },
      { orgId },
    );

    return { created: toCreate.map((t) => t.slug), skipped };
  }

  async materializeTemplate(
    actor: CurrentUserContext,
    templateId: string,
  ): Promise<typeof roles.$inferSelect> {
    if (!(await isStructuralOrgAdmin(this.db, actor)))
      throw new ForbiddenException(
        "Only an organization owner or administrator may add a role",
      );

    const template = ROLE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new NotFoundException("Role template not found");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)),
    });
    if (existing) return existing;

    await this.seedFromTemplate(actor.orgId, template);
    const [created] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.slug, template.slug), eq(roles.orgId, actor.orgId)))
      .limit(1);
    if (!created) throw new ConflictException("Role template could not be created");
    return created;
  }

  private async seedFromTemplate(orgId: string, template: RoleTemplate): Promise<void> {
    const validPermissions = template.permissions.filter((k) => CATALOG_KEYS.has(k));
    await runInTenantTransaction(
      this.db,
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

        await commitAccessChange(tx, orgId);
      },
      { orgId },
    );
  }
}
