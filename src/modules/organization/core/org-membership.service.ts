import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { InviteActor } from "./invitations.service";
import { assertInvitableRole } from "../../../common/rbac/assert-invitable-role";
import { AccessService } from "../../access/access.service";
import { and, count, desc, eq, ilike, inArray, lte, or } from "drizzle-orm";
import {
  moduleOwnerships,
  roleAssignments,
  roles,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  userPermissions,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bumpPermissionsVersion, type DbOrTx } from "../../../common/rbac/access-invalidate";
import { ORG_ADMIN_PERMISSION_KEY, ROLE_RANK } from "../../../common/rbac/grantability";
import { bustMembershipStatusCache } from "../../../common/auth/jwt-auth.guard";
import { SessionsService } from "../../sessions/sessions.service";
import { stableHash } from "../../../common/cache/cache-hash";
import type { ListMembersInput } from "./dto/organization.schemas";

const PG_FK_VIOLATION = "23503";

@Injectable()
export class OrgMembershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
  ) {}

  private async revokeMemberAccess(orgId: string, memberUserId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
    bustMembershipStatusCache(memberUserId, orgId);
    await this.sessions.revokeAllForUser(memberUserId);
  }

  private async invalidateMemberListCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidatePattern(CACHE_KEYS.orgMembersListPattern(orgId)),
      this.cache.invalidatePattern(CACHE_KEYS.orgMembersSimplePattern(orgId)),
      this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessCandidates(orgId)),
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
    const hash = stableHash({
      page,
      limit,
      search: search ?? null,
      userIds: userIds ? [...userIds].sort() : null,
    });
    return this.cache.cached(
      CACHE_KEYS.orgMembersList(orgId, hash),
      () => this.fetchMembers(orgId, page, limit, search, userIds),
      60,
    );
  }

  private async fetchMembers(
    orgId: string,
    page: number,
    limit: number,
    search: string | undefined,
    userIds: string[] | undefined,
  ) {
    const offset = (page - 1) * limit;
    const baseConditions = [eq(organizationMembers.orgId, orgId)];
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

        await tx
          .delete(userPermissions)
          .where(and(eq(userPermissions.orgId, orgId), eq(userPermissions.userId, memberUserId)));
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

  async suspendMember(orgId: string, actorUserId: string, memberUserId: string) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, memberUserId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { isOwner: true, status: true, id: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.isOwner) {
      throw new BadRequestException("Cannot suspend the organization owner");
    }
    if (member.status === "SUSPENDED") {
      throw new ConflictException("Member is already suspended");
    }

    await this.db.transaction(async (tx) => {
      const ownedModuleKeys = await this.queryOwnedModuleKeys(tx, orgId, member.id);
      if (ownedModuleKeys.length > 0) {
        throw new BadRequestException(
          `Transfer module ownership before suspending this member. Owned modules: ${ownedModuleKeys.join(", ")}.`,
        );
      }

      const privilegedRoles = await this.queryPrivilegedRoleNames(tx, orgId, member.id);
      if (privilegedRoles.length > 0) {
        throw new BadRequestException(
          `Remove administrative role(s) before suspending this member: ${privilegedRoles.join(", ")}.`,
        );
      }

      await tx
        .update(organizationMembers)
        .set({ status: "SUSPENDED", suspendedAt: new Date() })
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );
      await bumpPermissionsVersion(tx, orgId);
    });

    await this.revokeMemberAccess(orgId, memberUserId);
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: "org.member_suspended",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    return { success: true };
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(organizationMembers)
        .set({ status: "ACTIVE", activatedAt: new Date(), suspendedAt: null })
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );
      await bumpPermissionsVersion(tx, orgId);
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
    bustMembershipStatusCache(memberUserId, orgId);
    await this.invalidateMemberListCaches(orgId);

    this.audit.log({
      action: "org.member_reactivated",
      userId: actorUserId,
      orgId,
      targetId: memberUserId,
      targetType: "user",
    });

    return { success: true };
  }

  async updateMemberRole(
    orgId: string,
    actor: InviteActor,
    memberUserId: string,
    role: string,
  ) {
    const actorUserId = actor.userId;

    let isOrgAdmin = false;
    if (!actor.isOrgOwner) {
      const resolved = await this.access.resolveUserPermissions(orgId, actor.userId);
      isOrgAdmin = (resolved.get(ORG_ADMIN_PERMISSION_KEY) ?? "none") !== "none";
    }
    // Rejects OWNER outright (ownership moves only through the transfer flow)
    // and stops a non-admin handing out ORG_ADMIN.
    assertInvitableRole({ isOrgOwner: actor.isOrgOwner, isOrgAdmin }, role);

    await this.db.transaction(async (tx) => {
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
          .where(eq(organizationMembers.userId, userId))
          .orderBy(desc(organizationMembers.joinedAt))
          .limit(1);
        const fallbackOrgId = remaining?.orgId ?? null;
        await tx
          .update(users)
          .set({ lastActiveOrgId: fallbackOrgId })
          .where(and(eq(users.id, userId), eq(users.lastActiveOrgId, orgId)));
        return fallbackOrgId;
      });

      await this.cache.invalidate(CACHE_KEYS.userSession(userId));
      await this.invalidateMemberListCaches(orgId);
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
