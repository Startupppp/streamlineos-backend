import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  auditLogs,
  candidateOffers,
  departmentMembers,
  departments,
  leaveBlackoutDates,
  onboardingTasks,
  organizationMembers,
  organizations,
  userPermissions,
  userRoles,
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
import type {
  CreateOrganizationInput,
  ListMembersInput,
  TransferOwnershipInput,
} from "./dto/organization.schemas";

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Revoke every derived access path for a member so a suspend/remove takes effect immediately
   * across all layers: bump the org access version (invalidates cached resolved permissions),
   * drop the cached session + guard membership-status caches, and kill live sessions.
   */
  private async revokeMemberAccess(orgId: string, memberUserId: string): Promise<void> {
    await this.cache.invalidate(CACHE_KEYS.userSession(memberUserId));
    bustMembershipStatusCache(memberUserId, orgId);
    await this.sessions.revokeAllForUser(memberUserId);
  }

  async listUserOrganizations(userId: string) {
    const memberships = await this.db
      .select({
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(desc(organizationMembers.joinedAt));

    if (memberships.length === 0) return [];

    const orgIds = memberships.map((m) => m.orgId);
    const orgs = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const orgMap = new Map(orgs.map((o) => [o.id, o]));

    return memberships.map((m) => {
      const org = orgMap.get(m.orgId);
      return {
        id: org?.id ?? m.orgId,
        name: org?.name ?? "Unknown",
        slug: org?.slug ?? "",
        role: m.role,
        joinedAt: m.joinedAt,
      };
    });
  }

  async switchOrg(userId: string, targetOrgId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, targetOrgId),
      ),
      columns: { role: true },
    });
    if (!membership)
      throw new BadRequestException(
        "You are not a member of this organization",
      );

    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      })
      .from(organizations)
      .where(eq(organizations.id, targetOrgId))
      .limit(1);
    if (!org) throw new BadRequestException("Organization not found");

    await this.db
      .update(users)
      .set({ lastActiveOrgId: targetOrgId })
      .where(eq(users.id, userId));

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "org.switched", userId, orgId: targetOrgId });

    return {
      orgId: org.id,
      name: org.name,
      slug: org.slug,
      role: membership.role,
    };
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    const [existing] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.slug))
      .limit(1);

    if (existing)
      throw new ConflictException("Organization slug already exists");

    const orgId = randomUUID();

    let billingEmail: string | null = input.billingEmail ?? null;
    if (!billingEmail) {
      const [actor] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      billingEmail = actor?.email ?? null;
    }

    await this.db.transaction(async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.id);
      if (!Number.isInteger(ownerMembershipId)) {
        throw new Error("Failed to allocate owner membership id");
      }
      await tx.insert(organizations).values({
        id: orgId,
        name: input.name,
        slug: input.slug,
        billingEmail,
        ownerMembershipId,
      });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        userId,
        orgId,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
        activatedAt: new Date(),
      });
    });

    return { id: orgId, name: input.name, slug: input.slug };
  }

  async getProfile(userId: string, orgId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) return null;

    const [organization] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const [membership] = await this.db
      .select({
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
        ),
      );

    return {
      user,
      organization: organization ?? null,
      membership: membership ?? null,
    };
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
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, memberUserId),
            eq(organizationMembers.orgId, orgId),
          ),
        );

      // Purge derived grants so a re-invited member cannot silently resurrect old access.
      await tx
        .delete(userRoles)
        .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, memberUserId)));
      await tx
        .delete(userPermissions)
        .where(and(eq(userPermissions.orgId, orgId), eq(userPermissions.userId, memberUserId)));
      await tx.delete(departmentMembers).where(
        and(
          eq(departmentMembers.userId, memberUserId),
          inArray(
            departmentMembers.departmentId,
            tx.select({ id: departments.id }).from(departments).where(eq(departments.orgId, orgId)),
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
      await tx.update(users).set({ role }).where(eq(users.id, memberUserId));
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

  async archiveOrg(orgId: string, userId: string) {
    await this.db
      .update(organizations)
      .set({ status: "ARCHIVED", deletedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    this.audit.log({
      action: "org.archived",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true };
  }

  async restoreOrg(orgId: string, userId: string) {
    await this.db
      .update(organizations)
      .set({ status: "ACTIVE", deletedAt: null })
      .where(eq(organizations.id, orgId));
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    this.audit.log({
      action: "org.restored",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true };
  }

  async transferOwnership(
    orgId: string,
    currentOwnerId: string,
    input: TransferOwnershipInput,
  ) {
    if (input.newOwnerUserId === currentOwnerId) {
      throw new BadRequestException("You are already the owner");
    }

    const result = await this.db.transaction(async (tx) => {
      const [org] = await tx
        .select({ ownerMembershipId: organizations.ownerMembershipId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");

      const members = await tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          isOwner: organizationMembers.isOwner,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.userId, [
              currentOwnerId,
              input.newOwnerUserId,
            ]),
          ),
        )
        .for("update");

      const currentMember = members.find((m) => m.userId === currentOwnerId);
      const targetMember = members.find(
        (m) => m.userId === input.newOwnerUserId,
      );

      if (!currentMember) {
        throw new BadRequestException(
          "You are not a member of this organization",
        );
      }
      const isCurrentOwner =
        currentMember.isOwner ||
        (org.ownerMembershipId != null &&
          org.ownerMembershipId === currentMember.id);
      if (!isCurrentOwner) {
        throw new ForbiddenException(
          "Only the current owner can transfer ownership",
        );
      }
      if (!targetMember) {
        throw new BadRequestException(
          "New owner must be an existing org member",
        );
      }
      if (targetMember.status !== "ACTIVE") {
        throw new BadRequestException("New owner must be an active member");
      }

      await tx
        .update(organizationMembers)
        .set({ isOwner: false, role: "ADMIN" })
        .where(eq(organizationMembers.id, currentMember.id));
      await tx
        .update(organizationMembers)
        .set({ isOwner: true, role: "OWNER", status: "ACTIVE" })
        .where(eq(organizationMembers.id, targetMember.id));
      await tx
        .update(organizations)
        .set({ ownerMembershipId: targetMember.id })
        .where(eq(organizations.id, orgId));

      await bumpPermissionsVersion(tx, orgId);
      return { from: currentMember.userId, to: targetMember.userId };
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(currentOwnerId));
    await this.cache.invalidate(CACHE_KEYS.userSession(input.newOwnerUserId));
    this.audit.log({
      action: "org.ownership_transferred",
      userId: currentOwnerId,
      orgId,
      targetId: input.newOwnerUserId,
      targetType: "user",
      metadata: { from: result.from, to: result.to },
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

  async deleteOrg(orgId: string, userId: string, confirmation: string) {
    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found");

    const provided = confirmation.trim().toLowerCase();
    const matches =
      provided === org.name.trim().toLowerCase() ||
      (org.slug ? provided === org.slug.trim().toLowerCase() : false);
    if (!matches) {
      throw new BadRequestException(
        "Confirmation text does not match the organization name",
      );
    }

    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    await this.db.transaction(async (tx) => {
      await tx.delete(candidateOffers).where(eq(candidateOffers.orgId, orgId));
      await tx
        .delete(leaveBlackoutDates)
        .where(eq(leaveBlackoutDates.orgId, orgId));
      await tx.delete(onboardingTasks).where(eq(onboardingTasks.orgId, orgId));
      await tx
        .update(auditLogs)
        .set({ orgId: null })
        .where(eq(auditLogs.orgId, orgId));
      await tx.delete(organizations).where(eq(organizations.id, orgId));
    });

    for (const member of members) {
      await this.cache.invalidate(CACHE_KEYS.userSession(member.userId));
    }
    this.audit.log({
      action: "org.deleted",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { name: org.name },
    });
    return { success: true };
  }
}
