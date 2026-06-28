import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { organizationMembers, roles, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../common/access/invalidate";
import { ROLE_TEMPLATES, type RoleTemplate } from "./role-templates.constants";
import type { CloneTemplateInput, CreateRoleInput, UpdateRoleInput } from "./dto/rbac.schemas";

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  private assertCanManageAll(actor: CurrentUserContext, message: string): void {
    const ability = defineAbilityFor({
      isPlatformAdmin: actor.isPlatformAdmin,
      isOrgOwner: actor.isOrgOwner,
      permissions: actor.permissions,
      enabledModules: actor.enabledModules,
    });
    if (!ability.can("manage", "all")) throw new ForbiddenException(message);
  }

  async getRoles(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.rolesList(orgId),
      () =>
        this.db.query.roles.findMany({
          where: eq(roles.orgId, orgId),
          orderBy: [asc(roles.name)],
        }),
      CACHE_TTL.LONG,
    );
  }

  async getRole(orgId: string, roleId: number) {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  async createRole(actor: CurrentUserContext, input: CreateRoleInput) {
    this.assertCanManageAll(actor, "Only Owner, CEO, or CTO can create roles");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.slug, input.slug), eq(roles.orgId, actor.orgId)),
    });
    if (existing) throw new ConflictException("A role with this slug already exists");

    const [created] = await this.db
      .insert(roles)
      .values({
        name: input.name,
        slug: input.slug,
        orgId: actor.orgId,
        isSystem: false,
        permissions: input.permissions,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await bumpPermissionsVersion(this.db, actor.orgId);
    return created;
  }

  async updateRole(
    actor: CurrentUserContext,
    roleId: number,
    input: UpdateRoleInput,
  ): Promise<{ success: true }> {
    this.assertCanManageAll(actor, "Only Owner, CEO, or CTO can update roles");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
    });
    if (!existing) throw new NotFoundException("Role not found");

    const updateData: { updatedAt: Date; name?: string; permissions?: string[] } = {
      updatedAt: new Date(),
    };
    if (input.name && !existing.isSystem) updateData.name = input.name;
    if (input.permissions) updateData.permissions = input.permissions;

    await this.db
      .update(roles)
      .set(updateData)
      .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await bumpPermissionsVersion(this.db, actor.orgId);

    this.audit.log({
      action: "role.changed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: { name: input.name, permissionsUpdated: !!input.permissions },
    });

    return { success: true };
  }

  async deleteRole(actor: CurrentUserContext, roleId: number): Promise<{ success: true }> {
    this.assertCanManageAll(actor, "Only Owner, CEO, or CTO can delete roles");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)),
    });
    if (!existing) throw new NotFoundException("Role not found");
    if (existing.isSystem) throw new ForbiddenException("System roles cannot be deleted");

    const [{ value: userCount }] = await this.db
      .select({ value: count() })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, actor.orgId), eq(users.role, existing.slug)));

    if (Number(userCount) > 0) {
      throw new ConflictException(
        `Cannot delete role — ${userCount} user${Number(userCount) !== 1 ? "s are" : " is"} assigned to it. Reassign them first.`,
      );
    }

    await this.db.delete(roles).where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));

    return { success: true };
  }

  listTemplates(): readonly RoleTemplate[] {
    return ROLE_TEMPLATES;
  }

  async cloneTemplate(actor: CurrentUserContext, input: CloneTemplateInput) {
    this.assertCanManageAll(actor, "Only Owner, CEO, or CTO can create roles");

    const template = ROLE_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new NotFoundException("Template not found");

    const slug = input.slug ?? template.slug;
    const name = input.name ?? template.name;

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.slug, slug), eq(roles.orgId, actor.orgId)),
    });
    if (existing) throw new ConflictException(`A role with slug "${slug}" already exists`);

    const [created] = await this.db
      .insert(roles)
      .values({
        name,
        slug,
        orgId: actor.orgId,
        isSystem: false,
        permissions: [...template.permissions],
      })
      .returning();

    return created;
  }

  async simulatePermissions(actor: CurrentUserContext, targetUserId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, targetUserId),
        isNull(organizationMembers.leftAt),
      ),
    });

    if (!member) throw new ForbiddenException("Target user not found in this organization");

    const targetCtx: CurrentUserContext = {
      userId: targetUserId,
      orgId: actor.orgId,
      role: member.role,
      permissions: member.permissions ?? [],
      isOrgOwner: member.role === "OWNER",
    };

    const ability = defineAbilityFor(targetCtx);
    const permissions: string[] = targetCtx.permissions;

    const effectivePermissions = permissions.map((p) => {
      const [module, action] = p.split(":");
      return { permission: p, module: module ?? p, action: action ?? "*", granted: true };
    });

    const commonActions = [
      { action: "manage:all", label: "Manage all" },
      { action: "manage:settings", label: "Manage settings" },
      { action: "hr:employees:view", label: "View employees" },
      { action: "hr:employees:create", label: "Create employees" },
      { action: "settings:rbac:manage", label: "Manage RBAC" },
    ] as const;

    const checks = commonActions.map(({ action, label }) => {
      const [subject, act] = action.split(":");
      const granted = ability.can(act ?? "manage", subject ?? "all");
      return {
        permission: action,
        label,
        result: granted ? ("ALLOW" as const) : ("DENY" as const),
        reason: granted ? null : "FORBIDDEN",
      };
    });

    return {
      targetUserId,
      role: member.role,
      effectivePermissions,
      checks,
      isOwner: targetCtx.isOrgOwner,
    };
  }
}
