import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  candidateOffers,
  leaveBlackoutDates,
  onboardingTasks,
  organizationMembers,
  organizations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";

@Injectable()
export class OrgLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

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

    await this.db
      .update(organizations)
      .set({
        statusV2: "PURGE_SCHEDULED",
        purgeScheduledAt,
        purgeScheduledBy: actorUserId,
        purgeReason: reason,
        purgeJobId,
      })
      .where(eq(organizations.id, orgId));

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

    await this.db
      .update(organizations)
      .set({
        statusV2: "ACTIVE",
        purgeScheduledAt: null,
        purgeScheduledBy: null,
        purgeReason: null,
        purgeJobId: null,
      })
      .where(eq(organizations.id, orgId));

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
