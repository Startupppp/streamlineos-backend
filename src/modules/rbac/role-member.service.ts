import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  departmentMembers,
  departments,
  groupRoles,
  membershipRoleAssignments,
  organizationMembers,
  roles,
  userRoles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { RoleLockoutService } from "./role-lockout.service";
import type { RoleMemberInput } from "./dto/rbac.schemas";

@Injectable()
export class RoleMemberService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly lockout: RoleLockoutService,
  ) {}

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
        userId: userRoles.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.orgId, orgId), eq(userRoles.roleId, roleId)))
      .limit(100);

    const departmentRows = await this.db
      .select({ departmentId: groupRoles.groupId, name: departments.name })
      .from(groupRoles)
      .innerJoin(departments, eq(groupRoles.groupId, departments.id))
      .where(
        and(
          eq(groupRoles.orgId, orgId),
          eq(groupRoles.groupType, "department"),
          eq(groupRoles.roleId, roleId),
        ),
      )
      .limit(100);

    const departmentIds = departmentRows.map((row) => row.departmentId);
    const departmentNameById = new Map(
      departmentRows.map((row) => [row.departmentId, row.name] as const),
    );
    const viaDepartment =
      departmentIds.length > 0
        ? await this.db
            .select({
              userId: departmentMembers.userId,
              name: users.name,
              email: users.email,
              image: users.image,
              departmentId: departmentMembers.departmentId,
            })
            .from(departmentMembers)
            .innerJoin(users, eq(departmentMembers.userId, users.id))
            .where(inArray(departmentMembers.departmentId, departmentIds))
            .limit(500)
        : [];

    const members: Array<{
      id: string;
      principalType: "user" | "department";
      principalId: string;
      name: string | null;
      email: string | null;
      image: string | null;
      via: "direct" | "department";
      departmentId: number | null;
      departmentName: string | null;
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
        departmentId: null,
        departmentName: null,
      });
    }

    for (const row of departmentRows) {
      members.push({
        id: `department:${row.departmentId}`,
        principalType: "department",
        principalId: String(row.departmentId),
        name: row.name,
        email: null,
        image: null,
        via: "direct",
        departmentId: row.departmentId,
        departmentName: row.name,
      });
    }

    for (const member of viaDepartment) {
      members.push({
        id: `user:${member.userId}:dept:${member.departmentId}`,
        principalType: "user",
        principalId: member.userId,
        name: member.name,
        email: member.email,
        image: member.image,
        via: "department",
        departmentId: member.departmentId,
        departmentName: departmentNameById.get(member.departmentId) ?? null,
      });
    }

    return members;
  }

  async addRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    if (input.principalType === "user") {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, input.principalId),
        ),
        columns: { id: true },
      });
      if (!member)
        throw new BadRequestException(
          "User is not a member of this organization",
        );

      await this.db.transaction(async (tx): Promise<void> => {
        await tx
          .insert(userRoles)
          .values({
            orgId: actor.orgId,
            userId: input.principalId,
            roleId,
            assignedBy: actor.userId,
          })
          .onConflictDoNothing();
        await tx
          .insert(membershipRoleAssignments)
          .values({
            organizationId: actor.orgId,
            organizationMembershipId: member.id,
            roleId,
            assignedBy: actor.userId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      });
    } else {
      const department = await this.db.query.departments.findFirst({
        where: and(
          eq(departments.id, input.principalId),
          eq(departments.orgId, actor.orgId),
        ),
        columns: { id: true },
      });
      if (!department)
        throw new BadRequestException(
          "Department not found in this organization",
        );

      await this.db.transaction(async (tx): Promise<void> => {
        await tx
          .insert(groupRoles)
          .values({
            orgId: actor.orgId,
            groupType: "department",
            groupId: input.principalId,
            roleId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      });
    }

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.member.added",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: {
        principalType: input.principalType,
        principalId: input.principalId,
      },
    });

    if (input.principalType === "user") {
      void this.dispatch.emit({
        eventKey: "security.role.changed",
        orgId: actor.orgId,
        actorUserId: actor.userId,
        targetUserIds: [input.principalId],
        entityType: "role",
        entityId: String(roleId),
        title: "Your role or permissions were updated",
        message: "A role has been assigned to your account. Your access permissions may have changed.",
        link: "/settings/security",
      }).catch(() => undefined);
    }

    return { success: true };
  }

  async removeRoleMember(
    actor: CurrentUserContext,
    roleId: number,
    input: RoleMemberInput,
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    if (input.principalType === "user") {
      const willLockOut = await this.lockout.wouldLockOutLastAdmin(actor.orgId, input.principalId);
      if (willLockOut) {
        throw new ForbiddenException(
          "Cannot remove the last administrator with role-management access",
        );
      }
    }

    const membershipForRemoval = input.principalType === "user"
      ? await this.db.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, actor.orgId),
            eq(organizationMembers.userId, input.principalId),
          ),
          columns: { id: true },
        })
      : undefined;

    await this.db.transaction(async (tx): Promise<void> => {
      if (input.principalType === "user") {
        await tx
          .delete(userRoles)
          .where(
            and(
              eq(userRoles.orgId, actor.orgId),
              eq(userRoles.roleId, roleId),
              eq(userRoles.userId, input.principalId),
            ),
          );
        if (membershipForRemoval !== undefined) {
          await tx
            .delete(membershipRoleAssignments)
            .where(
              and(
                eq(membershipRoleAssignments.organizationId, actor.orgId),
                eq(membershipRoleAssignments.organizationMembershipId, membershipForRemoval.id),
                eq(membershipRoleAssignments.roleId, roleId),
              ),
            );
        }
      } else {
        await tx
          .delete(groupRoles)
          .where(
            and(
              eq(groupRoles.orgId, actor.orgId),
              eq(groupRoles.roleId, roleId),
              eq(groupRoles.groupType, "department"),
              eq(groupRoles.groupId, input.principalId),
            ),
          );
      }
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.member.removed",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: {
        principalType: input.principalType,
        principalId: input.principalId,
      },
    });

    if (input.principalType === "user") {
      void this.dispatch.emit({
        eventKey: "security.role.changed",
        orgId: actor.orgId,
        actorUserId: actor.userId,
        targetUserIds: [input.principalId],
        entityType: "role",
        entityId: String(roleId),
        title: "Your role or permissions were updated",
        message: "A role has been removed from your account. Your access permissions may have changed.",
        link: "/settings/security",
      }).catch(() => undefined);
    }

    return { success: true };
  }
}
