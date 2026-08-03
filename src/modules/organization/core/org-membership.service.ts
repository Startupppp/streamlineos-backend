import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { InviteActor } from "./invitations.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { assertTargetNotOwner } from "../../../common/rbac/assert-target-not-owner";
import { AccessService } from "../../access/access.service";
import { and, count, desc, eq, ilike, inArray, isNull, lte, or } from "drizzle-orm";
import {
  agentTokens,
  moduleOwnerships,
  roleAssignments,
  roles,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  userApiTokens,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustUsersStatsCache } from "../../../common/cache/bust-users-stats";
import { bumpPermissionsVersion, type DbOrTx } from "../../../common/rbac/access-invalidate";
import { ROLE_RANK } from "../../../common/rbac/grantability";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { SessionsService } from "../../sessions/sessions.service";
import { stableHash } from "../../../common/cache/cache-hash";
import type { ListMembersInput } from "./dto/organization.schemas";

const PG_FK_VIOLATION = "23503";

export type MemberLifecycleStatus = "active" | "suspended" | "archived";

export function membershipStatusToUserStatus(
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "LEFT",
): MemberLifecycleStatus {
  if (status === "SUSPENDED") return "suspended";
  if (status === "LEFT") return "archived";
  return "active";
}

export function userStatusToMembershipStatus(
  status: MemberLifecycleStatus,
): "ACTIVE" | "SUSPENDED" | "LEFT" {
  if (status === "suspended") return "SUSPENDED";
  if (status === "archived") return "LEFT";
  return "ACTIVE";
}

@Injectable()
export class OrgMembershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
  ) {}

  private async revokeOrgAgentTokensAndBustMembership(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    bustMembershipStatusCache(memberUserId, orgId);
    const now = new Date();
    await this.db
      .update(agentTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(agentTokens.userId, memberUserId),
          eq(agentTokens.orgId, orgId),
          isNull(agentTokens.revokedAt),
        ),
      );
  }

  private async revokeMemberAccess(orgId: string, memberUserId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
    await this.revokeOrgAgentTokensAndBustMembership(orgId, memberUserId);
    await this.sessions.revokeAllForUser(memberUserId);
    const now = new Date();
    await this.db
      .update(userApiTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(userApiTokens.userId, memberUserId), isNull(userApiTokens.revokedAt)),
      );
  }

  private async invalidateMemberListCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidatePattern(CACHE_KEYS.orgMembersListPattern(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.orgMembersSimplePattern(orgId)),
      this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessCandidates(orgId)),
      bustUsersStatsCache(this.cache, orgId),
    ]);
  }

  private async queryOwnedModuleKeys(
    db: DbOrTx,
    orgId: string,
    membershipId: number,
  ): Promise<string[]> {
    const rows = await db
      .select({ moduleKey: moduleOwnerships.moduleKey })
      .from(moduleOwnerships)
      .where(
        and(
          eq(moduleOwnerships.orgId, orgId),
          eq(moduleOwnerships.ownerMembershipId, membershipId),
        ),
      )
      .for("update");
    return rows.map((r) => r.moduleKey);
  }

  private async queryPrivilegedRoleNames(
    db: DbOrTx,
    orgId: string,
    membershipId: number,
  ): Promise<string[]> {
    const rows = await db
      .select({ name: roles.name })
      .from(roleAssignments)
      .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(roleAssignments.organizationMembershipId, membershipId),
          lte(roles.rank, ROLE_RANK.MODULE_ADMIN),
        ),
      );
    return rows.map((r) => r.name);
  }

  async listMembers(orgId: string, input: ListMembersInput) {
    const { page, limit, search, userIds } = input;
    const includeInactive = input.includeInactive === true;
    const hash = stableHash({
      page,
      limit,
      search: search ?? null,
      userIds: userIds ? [...userIds].sort() : null,
      includeInactive,
    });
    return this.cache.cached(
      CACHE_KEYS.orgMembersList(orgId, hash),
      () => this.fetchMembers(orgId, page, limit, search, userIds, includeInactive),
      60,
    );
  }

  private async fetchMembers(
    orgId: string,
    page: number,
    limit: number,
    search: string | undefined,
    userIds: string[] | undefined,
    includeInactive: boolean,
  ) {
    const offset = (page - 1) * limit;
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
    if (!includeInactive) {
      baseConditions.push(eq(organizationMembers.status, "ACTIVE"));
    }
    if (userIds && userIds.length > 0) {
      baseConditions.push(inArray(organizationMembers.userId, userIds));
    }
    const searchConditions = search
      ? [
          ...baseConditions,
          or(
            ilike(users.name, `%${search}%`),
            ilike(users.email, `%${search}%`),
          ),
        ]
      : baseConditions;

    const [dataResult, countResult] = await Promise.all([
      this.db
        .select({
          membershipId: organizationMembers.id,
          userId: organizationMembers.userId,
          role: organizationMembers.role,
          joinedAt: organizationMembers.joinedAt,
          name: users.name,
          email: users.email,
          image: users.image,
          totpEnabled: users.totpEnabled,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...searchConditions))
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...searchConditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data: dataResult,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    try {
      await this.db.transaction(async (tx) => {
        const [member] = await tx
          .select({ isOwner: organizationMembers.isOwner, id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          )
          .for("update")
          .limit(1);

        if (!member) throw new NotFoundException("Member not found");
        if (member.isOwner) {
          throw new BadRequestException(
            "Cannot remove the organization owner. Transfer ownership first.",
          );
        }

        const ownedModuleKeys = await this.queryOwnedModuleKeys(tx, orgId, member.id);
        if (ownedModuleKeys.length > 0) {
          throw new BadRequestException(
            `Transfer module ownership before removing this member. Owned modules: ${ownedModuleKeys.join(", ")}.`,
          );
        }

        const privilegedRoles = await this.queryPrivilegedRoleNames(tx, orgId, member.id);
        if (privilegedRoles.length > 0) {
          throw new BadRequestException(
            `Remove administrative role(s) before removing this member: ${privilegedRoles.join(", ")}.`,
          );
        }

        await tx
          .delete(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          );

        await tx.delete(orgUnitMembers).where(
          and(
            eq(orgUnitMembers.userId, memberUserId),
            inArray(
              orgUnitMembers.orgUnitId,
              tx.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.orgId, orgId)),
            ),
          ),
        );

        await bumpPermissionsVersion(tx, orgId);
      });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      if ((err as { code?: string }).code === PG_FK_VIOLATION) {
        throw new BadRequestException(
          "Cannot remove a member who owns a module. Transfer module ownership first.",
        );
      }
      throw err;
    }

    await this.revokeMemberAccess(orgId, memberUserId);
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: "org.member_removed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    return { success: true };
  }

  async setMemberLifecycleStatus(
    orgId: string,
    actorUserId: string,
    memberUserId: string,
    status: MemberLifecycleStatus,
    options?: { reason?: string; auditAction?: string },
  ) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, memberUserId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { isOwner: true, status: true, id: true },
    });
    if (!member) throw new NotFoundException("Member not found");

    const current = membershipStatusToUserStatus(member.status);
    if (status !== "active" && member.isOwner) {
      throw new BadRequestException(
        `The organization owner cannot be ${status}. Transfer ownership to another member first.`,
      );
    }
    if (current === "archived" && status === "suspended") {
      throw new BadRequestException("Cannot suspend an archived user. Restore the user first.");
    }
    if (status === "suspended" && current === "suspended") {
      throw new ConflictException("Member is already suspended");
    }
    if (status === "archived" && current === "archived") {
      throw new ConflictException("Member is already archived");
    }
    if (status === "active" && current === "active") {
      return { success: true };
    }

    const membershipStatus = userStatusToMembershipStatus(status);
    const now = new Date();
    const membershipUpdate =
      status === "active"
        ? {
            status: membershipStatus,
            activatedAt: now,
            suspendedAt: null,
            leftAt: null,
          }
        : status === "suspended"
          ? {
              status: membershipStatus,
              suspendedAt: now,
              leftAt: null,
            }
          : {
              status: membershipStatus,
              leftAt: now,
              suspendedAt: null,
            };

    await this.db.transaction(async (tx) => {
      if (status !== "active") {
        const ownedModuleKeys = await this.queryOwnedModuleKeys(tx, orgId, member.id);
        if (ownedModuleKeys.length > 0) {
          throw new BadRequestException(
            `Transfer module ownership before this action. Owned modules: ${ownedModuleKeys.join(", ")}.`,
          );
        }

        const privilegedRoles = await this.queryPrivilegedRoleNames(tx, orgId, member.id);
        if (privilegedRoles.length > 0) {
          throw new BadRequestException(
            `Remove administrative role(s) before this action: ${privilegedRoles.join(", ")}.`,
          );
        }
      }

      await tx
        .update(organizationMembers)
        .set(membershipUpdate)
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );
      await bumpPermissionsVersion(tx, orgId);
    });

    if (status !== "active") {
      await this.revokeMemberAccess(orgId, memberUserId);
    } else {
      await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
      bustMembershipStatusCache(memberUserId, orgId);
    }
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: options?.auditAction ?? `user.status.${status}`,
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: memberUserId,
      metadata: { status, reason: options?.reason },
    });

    return { success: true };
  }

  async suspendMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.setMemberLifecycleStatus(orgId, actorUserId, memberUserId, "suspended", {
      auditAction: "org.member_suspended",
    });
  }

  async reactivateMember(orgId: string, actorUserId: string, memberUserId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, memberUserId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { status: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.status !== "SUSPENDED") {
      throw new ConflictException("Member is not suspended");
    }
    return this.setMemberLifecycleStatus(orgId, actorUserId, memberUserId, "active", {
      auditAction: "org.member_reactivated",
    });
  }

  async updateMemberRole(
    orgId: string,
    actor: InviteActor,
    memberUserId: string,
    role: string,
  ) {
    const actorUserId = actor.userId;

    // Rejects OWNER outright (ownership moves only through the transfer flow) and stops a non-admin handing out ORG_ADMIN
    await assertMayGrantRole(this.access, orgId, actor, role);

    await this.db.transaction(async (tx) => {
      await assertTargetNotOwner(tx, orgId, memberUserId);
      const [member] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .for("update")
        .limit(1);

      if (!member) throw new NotFoundException("Member not found");

      const ownedModuleKeys = await this.queryOwnedModuleKeys(tx, orgId, member.id);
      if (ownedModuleKeys.length > 0) {
        throw new BadRequestException(
          `Transfer module ownership before changing this member's role. Owned modules: ${ownedModuleKeys.join(", ")}.`,
        );
      }

      await tx
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );

      await syncStructuralRoleAssignment(tx, orgId, member.id, role);
    });

    await Promise.all([
      this.invalidateMemberListCaches(orgId),
      this.cache.invalidate(CACHE_KEYS.orgProfile(orgId, memberUserId)),
    ]);

    this.audit.log({
      action: "org.member_role_changed",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
      metadata: { newRole: role },
    });

    return { success: true };
  }

  async leaveOrg(orgId: string, userId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { isOwner: true, id: true },
    });
    if (!membership) {
      throw new BadRequestException(
        "You are not a member of this organization",
      );
    }
    if (membership.isOwner) {
      throw new BadRequestException(
        "Owners cannot leave. Transfer ownership to another member or delete the organization.",
      );
    }

    try {
      const nextOrgId = await this.db.transaction(async (tx) => {
        const ownedModuleKeys = await this.queryOwnedModuleKeys(tx, orgId, membership.id);
        if (ownedModuleKeys.length > 0) {
          throw new BadRequestException(
            `Transfer module ownership before leaving this organization. Owned modules: ${ownedModuleKeys.join(", ")}.`,
          );
        }

        await tx
          .delete(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
          );
        const [remaining] = await tx
          .select({ orgId: organizationMembers.orgId })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, userId),
              eq(organizationMembers.status, "ACTIVE"),
            ),
          )
          .orderBy(desc(organizationMembers.joinedAt))
          .limit(1);
        const fallbackOrgId = remaining?.orgId ?? null;
        await tx
          .update(users)
          .set({ lastActiveOrgId: fallbackOrgId })
          .where(and(eq(users.id, userId), eq(users.lastActiveOrgId, orgId)));
        return fallbackOrgId;
      });

      await Promise.all([
        this.revokeOrgAgentTokensAndBustMembership(orgId, userId),
        this.cache.invalidate(CACHE_KEYS.userSession(userId)),
        this.cache.invalidate(CACHE_KEYS.orgProfile(orgId, userId)),
        this.invalidateMemberListCaches(orgId),
      ]);
      this.audit.log({
        action: "org.member_left",
        userId,
        orgId,
        targetId: userId,
        targetType: "user",
      });
      return { success: true, nextOrgId };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if ((err as { code?: string }).code === PG_FK_VIOLATION) {
        throw new BadRequestException(
          "Cannot leave an organization while owning a module. Transfer module ownership first.",
        );
      }
      throw err;
    }
  }
}
