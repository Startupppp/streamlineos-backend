import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  auditLogs,
  candidateOffers,
  leaveBlackoutDates,
  onboardingTasks,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { OrgMembershipService } from "./org-membership.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";

@Injectable()
export class OrgLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly orgMembership: OrgMembershipService,
    private readonly invitations: InvitationLifecycleService,
  ) {}

  private async listMemberUserIds(db: DbOrTx, orgId: string): Promise<string[]> {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    return members.map((m) => m.userId);
  }

  private async bustMembersMembership(orgId: string, memberUserIds: string[]): Promise<void> {
    await Promise.all(
      memberUserIds.map((memberUserId) =>
        Promise.all([
          bustMembershipStatusCache(this.cache, memberUserId, orgId),
          this.cache.invalidate(CACHE_KEYS.userSession(memberUserId)),
        ]),
      ),
    );
  }

  private async revokeMembersAccess(orgId: string, memberUserIds: string[]): Promise<void> {
    for (const memberUserId of memberUserIds) {
      await this.orgMembership.revokeOrgScopedAccess(orgId, memberUserId);
    }
  }

  private async findNextActiveOrgId(
    db: DbOrTx,
    userId: string,
    excludeOrgId: string,
  ): Promise<string | null> {
    const [remaining] = await db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
          ne(organizationMembers.orgId, excludeOrgId),
        ),
      )
      .orderBy(desc(organizationMembers.joinedAt))
      .limit(1);
    return remaining?.orgId ?? null;
  }

  private async resolveReplacementOrgIds(
    orgId: string,
    memberUserIds: string[],
  ): Promise<Map<string, string | null>> {
    const replacements = new Map<string, string | null>();
    for (const memberUserId of memberUserIds) {
      const nextOrgId = await withIdentity(this.db, memberUserId, (tx) =>
        this.findNextActiveOrgId(tx, memberUserId, orgId),
      );
      replacements.set(memberUserId, nextOrgId);
    }
    return replacements;
  }

  private async repairLastActiveOrgIds(
    db: DbOrTx,
    orgId: string,
    replacements: Map<string, string | null>,
  ): Promise<void> {
    for (const [memberUserId, nextOrgId] of replacements) {
      await db
        .update(users)
        .set({ lastActiveOrgId: nextOrgId })
        .where(
          and(
            eq(users.id, memberUserId),
            eq(users.lastActiveOrgId, orgId),
          ),
        );
    }
  }

  async listArchivedOwnedOrganizations(userId: string) {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.isOwner, true),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizations.status, "ARCHIVED"),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt)),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
    }));
  }

  async archiveOrg(orgId: string, userId: string) {
    const memberUserIds = await runInTenantTransaction(
      this.db,
      (tx) => this.listMemberUserIds(tx, orgId),
      { orgId },
    );
    const replacements = await this.resolveReplacementOrgIds(
      orgId,
      memberUserIds,
    );
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.repairLastActiveOrgIds(
          tx,
          orgId,
          replacements,
        );
        await tx
          .update(organizations)
          .set({ status: "ARCHIVED", deletedAt: new Date() })
          .where(eq(organizations.id, orgId));
        await this.invitations.revokeAllPending(orgId, tx);
      },
      { orgId },
    );
    const nextOrgId = replacements.get(userId) ?? null;

    await this.revokeMembersAccess(orgId, memberUserIds);
    await this.bustMembersMembership(orgId, memberUserIds);

    this.audit.log({
      action: "org.archived",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true as const, nextOrgId };
  }

  async restoreOrg(orgId: string, userId: string) {
    const [row] = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          orgStatus: organizations.status,
          isOwner: organizationMembers.isOwner,
          memberStatus: organizationMembers.status,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .limit(1),
    );

    if (!row || !row.isOwner || row.memberStatus !== "ACTIVE") {
      throw new NotFoundException("Organization not found");
    }
    if (row.orgStatus !== "ARCHIVED") {
      throw new BadRequestException("Organization is not archived");
    }

    const memberUserIds = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const ids = await this.listMemberUserIds(tx, orgId);
        await tx
          .update(organizations)
          .set({ status: "ACTIVE", deletedAt: null })
          .where(eq(organizations.id, orgId));
        await tx
          .update(users)
          .set({ lastActiveOrgId: orgId })
          .where(eq(users.id, userId));
        return ids;
      },
      { orgId },
    );

    await this.bustMembersMembership(orgId, memberUserIds);

    this.audit.log({
      action: "org.restored",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true as const, orgId };
  }

  async deleteOrg(orgId: string, userId: string, confirmation: string) {
    const [org] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
          })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),
      { orgId },
    );
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

    const memberUserIds = await runInTenantTransaction(
      this.db,
      (tx) => this.listMemberUserIds(tx, orgId),
      { orgId },
    );
    const replacements = await this.resolveReplacementOrgIds(
      orgId,
      memberUserIds,
    );
    const nextOrgId = replacements.get(userId) ?? null;
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.repairLastActiveOrgIds(tx, orgId, replacements);
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
      },
      { orgId },
    );

    await this.revokeMembersAccess(orgId, memberUserIds);
    await this.bustMembersMembership(orgId, memberUserIds);

    this.audit.log({
      action: "org.deleted",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { name: org.name },
    });
    return { success: true as const, nextOrgId };
  }

  async schedulePurge(
    orgId: string,
    actorUserId: string,
    scheduledForDays: number,
    reason: string,
  ): Promise<{ success: true; purgeJobId: string; purgeScheduledAt: Date }> {
    const [org] = await this.db
      .select({ id: organizations.id, statusV2: organizations.statusV2 })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found");
    if (org.statusV2 === "PURGED") {
      throw new BadRequestException("Organization is already purged");
    }

    const purgeJobId = randomUUID();
    const purgeScheduledAt = new Date(Date.now() + scheduledForDays * 24 * 60 * 60 * 1000);

    await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(organizations)
          .set({
            statusV2: "PURGE_SCHEDULED",
            purgeScheduledAt,
            purgeScheduledBy: actorUserId,
            purgeReason: reason,
            purgeJobId,
          })
          .where(eq(organizations.id, orgId)),
      { orgId },
    );

    this.audit.log({
      action: "org.purge_scheduled",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { purgeJobId, purgeScheduledAt, reason },
    });

    return { success: true, purgeJobId, purgeScheduledAt };
  }

  async cancelPurge(orgId: string, actorUserId: string): Promise<{ success: true }> {
    const [org] = await this.db
      .select({ id: organizations.id, statusV2: organizations.statusV2 })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found");
    if (org.statusV2 !== "PURGE_SCHEDULED") {
      throw new BadRequestException("No purge is scheduled for this organization");
    }

    await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(organizations)
          .set({
            statusV2: "ACTIVE",
            purgeScheduledAt: null,
            purgeScheduledBy: null,
            purgeReason: null,
            purgeJobId: null,
          })
          .where(eq(organizations.id, orgId)),
      { orgId },
    );

    this.audit.log({
      action: "org.purge_cancelled",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    return { success: true };
  }
}
