import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  ownershipTransfers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { ACCESS_MANAGED_MODULES, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";
import type {
  AddModuleGroupMemberInput,
  CreateModuleGroupInput,
  InitiateOwnershipTransferInput,
  RenameModuleGroupInput,
} from "./dto/module-access.schemas";

const MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);
const ORG_ADMIN_KEY = "settings:rbac:manage";

function moduleOf(permissionKey: string): string {
  return permissionKey.split(":")[0] ?? permissionKey;
}

export interface ModuleRoleGroup {
  id: number;
  name: string;
  isSystem: boolean;
  memberCount: number;
  permissions: { permissionKey: string; scope: DataScope }[];
}

export interface ModuleGroupMember {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface ModuleMemberCandidate {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

export interface ModuleOwnership {
  moduleKey: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  pendingTransfer: {
    transferId: string;
    toUserId: string;
    toDisplayName: string;
    toEmail: string;
    initiatedAt: string;
  } | null;
}

@Injectable()
export class ModuleAccessGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly cache: CacheService,
  ) {}

  private assertKnownModule(moduleKey: string): void {
    if (!MANAGED_MODULES.has(moduleKey)) {
      throw new NotFoundException(
        `Access is not separately managed for module "${moduleKey}"`,
      );
    }
  }

  private async assertAccess(
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ): Promise<void> {
    this.assertKnownModule(moduleKey);
    if (actor.isOrgOwner || actor.isPlatformAdmin) return;
    const resolved = await this.access.resolveUserPermissions(actor.orgId, actor.userId);
    const isOrgAdmin = (resolved.get(ORG_ADMIN_KEY) ?? "none") !== "none";
    if (isOrgAdmin) return;
    const scope = resolved.get(`${moduleKey}:access:${action}`);
    if (!scope || scope === "none") {
      throw new ForbiddenException("You do not have access to manage this module's roles");
    }
  }

  private modulePermissionKeys(moduleKey: string): Set<string> {
    return new Set(
      PERMISSIONS.filter((p) => moduleOf(p.name) === moduleKey).map((p) => p.name),
    );
  }

  private async assertGroupBelongsToModule(
    orgId: string,
    moduleKey: string,
    groupId: number,
  ): Promise<void> {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, groupId), eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)),
      columns: { id: true },
    });
    if (!role) throw new NotFoundException("Group not found");
  }

  async listGroups(actor: CurrentUserContext, moduleKey: string): Promise<ModuleRoleGroup[]> {
    await this.assertAccess(actor, moduleKey, "view");
    const catalog = this.modulePermissionKeys(moduleKey);

    const orgRoles = await this.db
      .select({ id: roles.id, name: roles.name, slug: roles.slug, isSystem: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)))
      .orderBy(asc(roles.name))
      .limit(100);

    if (orgRoles.length === 0) return [];

    const roleIds = orgRoles.map((r) => r.id);

    const [memberCountRows, grantRows] = await Promise.all([
      this.db
        .select({ roleId: roleAssignments.roleId, cnt: count() })
        .from(roleAssignments)
        .where(
          and(eq(roleAssignments.orgId, actor.orgId), inArray(roleAssignments.roleId, roleIds)),
        )
        .groupBy(roleAssignments.roleId),
      this.db
        .select({
          roleId: rolePermissionGrants.roleId,
          permissionKey: rolePermissionGrants.permissionKey,
          scope: rolePermissionGrants.scope,
        })
        .from(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, actor.orgId),
            inArray(rolePermissionGrants.roleId, roleIds),
          ),
        )
        .limit(5000),
    ]);

    const memberCountById = new Map<number, number>(
      memberCountRows.map((r) => [r.roleId, Number(r.cnt)]),
    );

    const moduleGrantsByRole = new Map<number, { permissionKey: string; scope: DataScope }[]>();
    const rolesWithAnyGrant = new Set<number>();

    for (const grant of grantRows) {
      rolesWithAnyGrant.add(grant.roleId);
      if (!catalog.has(grant.permissionKey)) continue;
      const list = moduleGrantsByRole.get(grant.roleId) ?? [];
      list.push({ permissionKey: grant.permissionKey, scope: grant.scope });
      moduleGrantsByRole.set(grant.roleId, list);
    }

    return orgRoles.map((role) => {
      let permissions = moduleGrantsByRole.get(role.id);
      if (!permissions && !rolesWithAnyGrant.has(role.id)) {
        permissions = (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? [])
          .filter((key) => catalog.has(key))
          .map((permissionKey) => ({ permissionKey, scope: "all" as DataScope }));
      }
      return {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        memberCount: memberCountById.get(role.id) ?? 0,
        permissions: permissions ?? [],
      };
    });
  }

  async createGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    input: CreateModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");

    const slug = `${moduleKey.toUpperCase()}_${input.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${Date.now()}`;

    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(roles)
        .values({ name: input.name, slug, orgId: actor.orgId, isSystem: false, moduleKey })
        .returning({ id: roles.id, name: roles.name, isSystem: roles.isSystem });
      if (!created) throw new BadRequestException("Failed to create group");
      await bumpPermissionsVersion(tx, actor.orgId);
      return created;
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return { id: row.id, name: row.name, isSystem: row.isSystem, memberCount: 0, permissions: [] };
  }

  async renameGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: RenameModuleGroupInput,
  ): Promise<ModuleRoleGroup> {
    await this.assertAccess(actor, moduleKey, "manage");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)),
    });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem) throw new ForbiddenException("System groups cannot be renamed");

    const [row] = await this.db
      .update(roles)
      .set({ name: input.name, updatedAt: new Date() })
      .where(and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId)))
      .returning({ id: roles.id, name: roles.name, isSystem: roles.isSystem });

    if (!row) throw new BadRequestException("Failed to rename group");

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return { id: row.id, name: row.name, isSystem: row.isSystem, memberCount: 0, permissions: [] };
  }

  async deleteGroup(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    const existing = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId), eq(roles.moduleKey, moduleKey)),
    });
    if (!existing) throw new NotFoundException("Group not found");
    if (existing.isSystem) throw new ForbiddenException("System groups cannot be deleted");

    const [assignmentCountRow] = await this.db
      .select({ cnt: count() })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.orgId, actor.orgId), eq(roleAssignments.roleId, groupId)));

    if (Number(assignmentCountRow?.cnt ?? 0) > 0) {
      throw new ConflictException(
        "Cannot delete a group with active member assignments. Remove all members first.",
      );
    }

    await this.db.transaction(async (tx): Promise<void> => {
      await tx
        .delete(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, actor.orgId),
            eq(rolePermissionGrants.roleId, groupId),
          ),
        );
      await tx.delete(roles).where(and(eq(roles.id, groupId), eq(roles.orgId, actor.orgId)));
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return { success: true };
  }

  async listGroupMembers(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
  ): Promise<ModuleGroupMember[]> {
    await this.assertAccess(actor, moduleKey, "view");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(roleAssignments.orgId, actor.orgId), eq(roleAssignments.roleId, groupId)))
      .limit(100);

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.name ?? r.email ?? r.userId,
      email: r.email ?? "",
      avatarUrl: r.image,
    }));
  }

  async addGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    input: AddModuleGroupMemberInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, input.userId),
      ),
      columns: { id: true },
    });
    if (!member) throw new BadRequestException("User is not a member of this organization");

    await this.db.transaction(async (tx): Promise<void> => {
      await tx
        .insert(roleAssignments)
        .values({
          orgId: actor.orgId,
          organizationMembershipId: member.id,
          roleId: groupId,
          assignedByMembershipId: null,
        })
        .onConflictDoNothing();
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    return { success: true };
  }

  async removeGroupMember(
    actor: CurrentUserContext,
    moduleKey: string,
    groupId: number,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");
    await this.assertGroupBelongsToModule(actor.orgId, moduleKey, groupId);

    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });

    if (member) {
      await this.db.transaction(async (tx): Promise<void> => {
        await tx
          .delete(roleAssignments)
          .where(
            and(
              eq(roleAssignments.orgId, actor.orgId),
              eq(roleAssignments.roleId, groupId),
              eq(roleAssignments.organizationMembershipId, member.id),
            ),
          );
        await bumpPermissionsVersion(tx, actor.orgId);
      });
      await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    }

    return { success: true };
  }

  async listMemberCandidates(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleMemberCandidate[]> {
    await this.assertAccess(actor, moduleKey, "view");

    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(eq(organizationMembers.orgId, actor.orgId), eq(organizationMembers.status, "ACTIVE")),
      )
      .orderBy(asc(users.name))
      .limit(200);

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.name ?? r.email ?? r.userId,
      email: r.email ?? "",
      avatarUrl: r.image,
    }));
  }

  async getOwnership(actor: CurrentUserContext, moduleKey: string): Promise<ModuleOwnership> {
    await this.assertAccess(actor, moduleKey, "view");

    const [ownerRow] = await this.db
      .select({
        ownerUserId: organizationMembers.userId,
        ownerMembershipId: moduleOwnerships.ownerMembershipId,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(moduleOwnerships)
      .innerJoin(
        organizationMembers,
        and(
          eq(moduleOwnerships.orgId, organizationMembers.orgId),
          eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(eq(moduleOwnerships.orgId, actor.orgId), eq(moduleOwnerships.moduleKey, moduleKey)),
      )
      .limit(1);

    if (!ownerRow) throw new NotFoundException("Module ownership not configured");

    const [pendingRow] = await this.db
      .select({
        id: ownershipTransfers.id,
        toMembershipId: ownershipTransfers.toMembershipId,
        initiatedAt: ownershipTransfers.initiatedAt,
      })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, actor.orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    let pendingTransfer: ModuleOwnership["pendingTransfer"] = null;

    if (pendingRow) {
      const [toMember] = await this.db
        .select({ userId: organizationMembers.userId, name: users.name, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(organizationMembers.id, pendingRow.toMembershipId),
          ),
        )
        .limit(1);

      if (toMember) {
        pendingTransfer = {
          transferId: pendingRow.id,
          toUserId: toMember.userId,
          toDisplayName: toMember.name ?? toMember.email ?? toMember.userId,
          toEmail: toMember.email ?? "",
          initiatedAt: pendingRow.initiatedAt.toISOString(),
        };
      }
    }

    return {
      moduleKey,
      ownerId: ownerRow.ownerUserId,
      ownerDisplayName: ownerRow.ownerName ?? ownerRow.ownerEmail ?? ownerRow.ownerUserId,
      ownerEmail: ownerRow.ownerEmail ?? "",
      pendingTransfer,
    };
  }

  async initiateOwnershipTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
    input: InitiateOwnershipTransferInput,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    const [actorMembership, toMembership] = await Promise.all([
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, actor.userId),
        ),
        columns: { id: true },
      }),
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, input.toUserId),
        ),
        columns: { id: true, status: true },
      }),
    ]);

    if (!actorMembership) throw new ForbiddenException("Not a member of this organization");
    if (!toMembership) throw new NotFoundException("Target user is not a member of this organization");
    if (toMembership.status !== "ACTIVE") throw new BadRequestException("Target membership must be ACTIVE");
    if (actorMembership.id === toMembership.id) throw new BadRequestException("Cannot transfer ownership to yourself");

    try {
      const expiresAt = new Date(Date.now() + 48 * 3_600_000);
      await this.db.insert(ownershipTransfers).values({
        orgId: actor.orgId,
        scope: "MODULE",
        moduleKey,
        fromMembershipId: actorMembership.id,
        toMembershipId: toMembership.id,
        status: "PENDING",
        expiresAt,
        reason: null,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        throw new ConflictException(`A pending transfer for module "${moduleKey}" already exists`);
      }
      throw err;
    }

    return { success: true };
  }

  async cancelOwnershipTransfer(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<{ success: true }> {
    await this.assertAccess(actor, moduleKey, "manage");

    const [transfer] = await this.db
      .select({ id: ownershipTransfers.id, fromMembershipId: ownershipTransfers.fromMembershipId })
      .from(ownershipTransfers)
      .where(
        and(
          eq(ownershipTransfers.orgId, actor.orgId),
          eq(ownershipTransfers.moduleKey, moduleKey),
          eq(ownershipTransfers.scope, "MODULE"),
          eq(ownershipTransfers.status, "PENDING"),
        ),
      )
      .limit(1);

    if (!transfer) throw new NotFoundException("No pending transfer found for this module");

    if (!actor.isOrgOwner && !actor.isPlatformAdmin) {
      const actorMembership = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, actor.userId),
        ),
        columns: { id: true },
      });
      if (!actorMembership || actorMembership.id !== transfer.fromMembershipId) {
        throw new ForbiddenException(
          "Only the transfer initiator or an org owner may cancel this transfer",
        );
      }
    }

    await this.db
      .update(ownershipTransfers)
      .set({ status: "CANCELLED" })
      .where(eq(ownershipTransfers.id, transfer.id));

    return { success: true };
  }
}
