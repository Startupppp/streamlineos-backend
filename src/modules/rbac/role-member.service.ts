import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  groupRoleAssignments,
  organizationMembers,
  principalGroupMembers,
  principalGroups,
  roleAssignments,
  roles,
  users,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import {
  commitAccessChange,
  type CommitAccessOpts,
} from "../../common/rbac/access-mutation-commit";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { DispatchEventInput } from "../notifications/notification.types";
import type { RoleMemberInput } from "./dto/rbac.schemas";
import { assertMayAssignRole } from "./assert-role-assignment";
import { writeUserModuleAccessOverride } from "../access/user-module-access.writer";

@Injectable()
export class RoleMemberService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
    private readonly access: AccessService,
  ) {}

  private roleMemberCommit(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
    change: "added" | "removed",
  ): CommitAccessOpts<DispatchEventInput> {
    const isUser = input.principalType === "user";
    return {
      audit: {
        action: `role.member.${change}`,
        userId: actor.userId,
        targetId: String(roleId),
        targetType: "role",
        metadata: { principalType: input.principalType, principalId: input.principalId },
      },
      revoke: {
        cache: this.cache,
        loses: [
          { kind: "role-holders", roleId },
          isUser
            ? { kind: "permissions", userIds: [input.principalId] }
            : { kind: "group-members", groupId: input.principalId },
        ],
        listKeys: [CACHE_KEYS.rolesList(actor.orgId)],
      },
      notify: {
        via: this.dispatch,
        events: isUser
          ? [
              {
                eventKey: "security.role.changed",
                orgId: actor.orgId,
                actorUserId: actor.userId,
                targetUserIds: [input.principalId],
                entityType: "role",
                entityId: String(roleId),
                title: "Your role or permissions were updated",
                message:
                  change === "added"
                    ? "A role has been assigned to your account. Your access permissions may have changed."
                    : "A role has been removed from your account. Your access permissions may have changed.",
                link: "/settings/security",
              },
            ]
          : [],
      },
    };
  }

  private async getRole(orgId: string, roleId: number) {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  async getRoleMembers(orgId: string, roleId: number) {
    await this.getRole(orgId, roleId);

    const direct = await this.db
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
      .where(and(eq(roleAssignments.orgId, orgId), eq(roleAssignments.roleId, roleId)))
      .limit(100);

    const groupRows = await this.db
      .select({ groupId: groupRoleAssignments.principalGroupId, groupName: principalGroups.name, groupKind: principalGroups.kind })
      .from(groupRoleAssignments)
      .innerJoin(principalGroups, eq(groupRoleAssignments.principalGroupId, principalGroups.id))
      .where(
        and(
          eq(groupRoleAssignments.orgId, orgId),
          eq(groupRoleAssignments.roleId, roleId),
        ),
      )
      .limit(100);

    const groupIds = groupRows.map((row) => row.groupId);
    const groupNameById = new Map(groupRows.map((row) => [row.groupId, row.groupName] as const));

    const viaGroup =
      groupIds.length > 0
        ? await this.db
            .select({
              userId: organizationMembers.userId,
              name: users.name,
              email: users.email,
              image: users.image,
              groupId: principalGroupMembers.principalGroupId,
            })
            .from(principalGroupMembers)
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.orgId, principalGroupMembers.orgId),
                eq(organizationMembers.id, principalGroupMembers.organizationMembershipId),
              ),
            )
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .where(inArray(principalGroupMembers.principalGroupId, groupIds))
            .limit(500)
        : [];

    const members: Array<{
      id: string;
      principalType: "user" | "group";
      principalId: string;
      name: string | null;
      email: string | null;
      image: string | null;
      via: "direct" | "group";
      groupId: string | null;
      groupName: string | null;
    }> = [];

    for (const member of direct) {
      members.push({
        id: `user:${member.userId}`,
        principalType: "user",
        principalId: member.userId,
        name: member.name,
        email: member.email,
        image: member.image,
        via: "direct",
        groupId: null,
        groupName: null,
      });
    }

    for (const row of groupRows) {
      members.push({
        id: `group:${row.groupId}`,
        principalType: "group",
        principalId: row.groupId,
        name: row.groupName,
        email: null,
        image: null,
        via: "direct",
        groupId: row.groupId,
        groupName: row.groupName,
      });
    }

    for (const member of viaGroup) {
      members.push({
        id: `user:${member.userId}:group:${member.groupId}`,
        principalType: "user",
        principalId: member.userId,
        name: member.name,
        email: member.email,
        image: member.image,
        via: "group",
        groupId: member.groupId,
        groupName: groupNameById.get(member.groupId) ?? null,
      });
    }

    return members;
  }

  async addRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    const role = await this.getRole(actor.orgId, roleId);

    if (
      !actor.isOrgOwner &&
      input.principalType === "user" &&
      input.principalId === actor.userId
    ) {
      throw new ForbiddenException("You cannot assign a role to yourself");
    }

    await assertMayAssignRole(this.db, this.access, actor, role);

    if (input.principalType === "user") {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, input.principalId),
        ),
        columns: { id: true, status: true },
      });
      if (!member || member.status !== "ACTIVE")
        throw new BadRequestException(
          "User must be an active member of this organization",
        );

      await runInTenantTransaction(this.db, async (tx): Promise<void> => {
        await tx
          .insert(roleAssignments)
          .values({
            orgId: actor.orgId,
            organizationMembershipId: member.id,
            roleId,
            assignedByMembershipId: null,
          })
          .onConflictDoNothing();
        if (role.moduleKey) {
          await writeUserModuleAccessOverride(
            tx,
            actor.orgId,
            member.id,
            role.moduleKey,
            true,
            actor.userId,
          );
        }
        await commitAccessChange(
          tx,
          actor.orgId,
          this.roleMemberCommit(actor, roleId, input, "added"),
        );
      }, { orgId: actor.orgId });
    } else {
      const group = await this.db.query.principalGroups.findFirst({
        where: and(
          eq(principalGroups.id, input.principalId),
          eq(principalGroups.orgId, actor.orgId),
        ),
        columns: { id: true },
      });
      if (!group)
        throw new BadRequestException(
          "Group not found in this organization",
        );

      await runInTenantTransaction(this.db, async (tx): Promise<void> => {
        await tx
          .insert(groupRoleAssignments)
          .values({
            orgId: actor.orgId,
            principalGroupId: input.principalId,
            roleId,
          })
          .onConflictDoNothing();
        await commitAccessChange(
          tx,
          actor.orgId,
          this.roleMemberCommit(actor, roleId, input, "added"),
        );
      }, { orgId: actor.orgId });
    }

    return { success: true };
  }

  async removeRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    const membershipForRemoval = input.principalType === "user"
      ? await this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(organizationMembers.userId, input.principalId),
          ),
          columns: { id: true },
        })
      : undefined;

    await runInTenantTransaction(this.db, async (tx): Promise<void> => {
      if (input.principalType === "user") {
        if (membershipForRemoval !== undefined) {
          await tx
            .delete(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, actor.orgId),
                eq(roleAssignments.roleId, roleId),
                eq(roleAssignments.organizationMembershipId, membershipForRemoval.id),
              ),
            );
        }
      } else {
        await tx
          .delete(groupRoleAssignments)
          .where(
            and(
              eq(groupRoleAssignments.orgId, actor.orgId),
              eq(groupRoleAssignments.roleId, roleId),
              eq(groupRoleAssignments.principalGroupId, input.principalId),
            ),
          );
      }
      await commitAccessChange(
        tx,
        actor.orgId,
        this.roleMemberCommit(actor, roleId, input, "removed"),
      );
    }, { orgId: actor.orgId });

    return { success: true };
  }
}
