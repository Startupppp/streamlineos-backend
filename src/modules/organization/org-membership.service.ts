import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import {
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  userPermissions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { bustMembershipStatusCache } from "../../common/auth/jwt-auth.guard";
import { SessionsService } from "../sessions/sessions.service";
import type { ListMembersInput } from "./dto/organization.schemas";

@Injectable()
export class OrgMembershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
  ) {}

  private async revokeMemberAccess(orgId: string, memberUserId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
    bustMembershipStatusCache(memberUserId, orgId);
    await this.sessions.revokeAllForUser(memberUserId);
  }

  async listMembers(orgId: string, { page, limit, search, userIds }: ListMembersInput) {
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
    await this.db.transaction(async (tx) => {
      const [member] = await tx
        .select({ isOwner: organizationMembers.isOwner })
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

    await this.revokeMemberAccess(orgId, memberUserId);

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
      columns: { isOwner: true, status: true },
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.isOwner) {
      throw new BadRequestException("Cannot suspend the organization owner");
    }
    if (member.status === "SUSPENDED") {
      throw new ConflictException("Member is already suspended");
    }

    await this.db.transaction(async (tx) => {
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
    actorUserId: string,
    memberUserId: string,
    role: string,
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );
    });

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
      columns: { isOwner: true },
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

    const nextOrgId = await this.db.transaction(async (tx) => {
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
    this.audit.log({
      action: "org.member_left",
      userId,
      orgId,
      targetId: userId,
      targetType: "user",
    });
    return { success: true, nextOrgId };
  }
}
