import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql, sum } from "drizzle-orm";
import { hrAuditLogs, organizationMembers, recognitions } from "../../../db/schema";
import {
  hrBadgeAwards,
  hrBadges,
  hrRewardPointsLedger,
} from "../../../db/schema/hr/engagement-extras";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import type {
  AwardBadgeInput,
  CreateBadgeInput,
} from "./dto/engagement-extras.schemas";

@Injectable()
export class EngagementBadgesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listBadges(orgId: string) {
    return this.db
      .select()
      .from(hrBadges)
      .where(eq(hrBadges.orgId, orgId))
      .orderBy(desc(hrBadges.createdAt))
      .limit(100);
  }

  async createBadge(orgId: string, input: CreateBadgeInput) {
    const [badge] = await this.db
      .insert(hrBadges)
      .values({
        orgId,
        name: input.name,
        description: input.description,
        icon: input.icon,
        points: input.points ?? 10,
      })
      .returning()
      .catch(() => {
        throw new ConflictException(`Badge "${input.name}" already exists.`);
      });
    return badge;
  }

  async deleteBadge(orgId: string, badgeId: number) {
    const [badge] = await this.db
      .select({ id: hrBadges.id })
      .from(hrBadges)
      .where(and(eq(hrBadges.id, badgeId), eq(hrBadges.orgId, orgId)));
    if (!badge) throw new NotFoundException("Badge not found.");
    await this.db
      .delete(hrBadges)
      .where(and(eq(hrBadges.id, badgeId), eq(hrBadges.orgId, orgId)));
    return { success: true };
  }

  async awardBadge(
    orgId: string,
    awardedBy: string,
    badgeId: number,
    input: AwardBadgeInput,
  ) {
    const [badge] = await this.db
      .select()
      .from(hrBadges)
      .where(and(eq(hrBadges.id, badgeId), eq(hrBadges.orgId, orgId)));
    if (!badge) throw new NotFoundException("Badge not found.");

    return this.db.transaction(async (tx) => {
      const [award] = await tx
        .insert(hrBadgeAwards)
        .values({
          orgId,
          badgeId,
          userId: input.userId,
          awardedBy,
          reason: input.reason ?? null,
        })
        .returning();

      await tx.insert(hrRewardPointsLedger).values({
        orgId,
        userId: input.userId,
        points: badge.points,
        source: "badge",
        sourceId: String(award.id),
        note: `Badge: ${badge.name}`,
      });

      const [awardedByMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, awardedBy)))
        .limit(1);

      await tx.insert(hrAuditLogs).values({
        orgId,
        actorMembershipId: awardedByMember?.id ?? null,
        entityType: "hr_recognition",
        entityId: String(award.id),
        action: "badge_awarded",
        after: {
          badgeId,
          badgeName: badge.name,
          userId: input.userId,
          reason: input.reason,
        },
      });

      return award;
    });
  }

  async myBadges(orgId: string, userId: string) {
    const awards = await this.db
      .select({
        id: hrBadgeAwards.id,
        badgeId: hrBadgeAwards.badgeId,
        userId: hrBadgeAwards.userId,
        awardedBy: hrBadgeAwards.awardedBy,
        reason: hrBadgeAwards.reason,
        createdAt: hrBadgeAwards.createdAt,
        badgeName: hrBadges.name,
        badgeDescription: hrBadges.description,
        badgeIcon: hrBadges.icon,
        badgePoints: hrBadges.points,
      })
      .from(hrBadgeAwards)
      .leftJoin(hrBadges, eq(hrBadgeAwards.badgeId, hrBadges.id))
      .where(
        and(
          eq(hrBadgeAwards.orgId, orgId),
          eq(hrBadgeAwards.userId, userId),
        ),
      )
      .orderBy(desc(hrBadgeAwards.createdAt))
      .limit(100);

    return awards.map((a) => ({
      id: a.id,
      badgeId: a.badgeId,
      userId: a.userId,
      awardedBy: a.awardedBy,
      reason: a.reason,
      createdAt: a.createdAt,
      badge: a.badgeName
        ? {
            id: a.badgeId,
            name: a.badgeName,
            description: a.badgeDescription,
            icon: a.badgeIcon,
            points: a.badgePoints,
          }
        : null,
    }));
  }

  myPoints(orgId: string, userId: string) {
    return this.db
      .select({
        id: hrRewardPointsLedger.id,
        points: hrRewardPointsLedger.points,
        source: hrRewardPointsLedger.source,
        note: hrRewardPointsLedger.note,
        createdAt: hrRewardPointsLedger.createdAt,
      })
      .from(hrRewardPointsLedger)
      .where(
        and(
          eq(hrRewardPointsLedger.orgId, orgId),
          eq(hrRewardPointsLedger.userId, userId),
        ),
      )
      .orderBy(desc(hrRewardPointsLedger.createdAt))
      .limit(100);
  }

  async leaderboard(orgId: string, topN = 20) {
    const rows = await this.db
      .select({
        userId: hrRewardPointsLedger.userId,
        total: sum(hrRewardPointsLedger.points),
      })
      .from(hrRewardPointsLedger)
      .where(eq(hrRewardPointsLedger.orgId, orgId))
      .groupBy(hrRewardPointsLedger.userId)
      .orderBy(desc(sum(hrRewardPointsLedger.points)))
      .limit(topN);

    return rows.map((r) => ({ userId: r.userId, total: Number(r.total ?? 0) }));
  }

  async employeeOfMonth(orgId: string) {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const recognitionCounts = await this.db
      .select({
        userId: recognitions.toUserId,
        count: sql<number>`count(*)::int`,
      })
      .from(recognitions)
      .where(
        and(
          eq(recognitions.orgId, orgId),
          sql`${recognitions.createdAt} >= ${periodStart}`,
        ),
      )
      .groupBy(recognitions.toUserId)
      .orderBy(desc(sql`count(*)`))
      .limit(5);

    const pointsSums = await this.db
      .select({
        userId: hrRewardPointsLedger.userId,
        total: sum(hrRewardPointsLedger.points),
      })
      .from(hrRewardPointsLedger)
      .where(
        and(
          eq(hrRewardPointsLedger.orgId, orgId),
          sql`${hrRewardPointsLedger.createdAt} >= ${periodStart.toISOString()}`,
        ),
      )
      .groupBy(hrRewardPointsLedger.userId);

    const pointsByUser = new Map(
      pointsSums.map((r) => [r.userId, Number(r.total ?? 0)]),
    );

    const scored = recognitionCounts.map((r) => ({
      userId: r.userId,
      recognitions: r.count,
      points: pointsByUser.get(r.userId) ?? 0,
      score: r.count * 3 + (pointsByUser.get(r.userId) ?? 0),
    }));

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0] ?? null;
    return {
      period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
      top,
    };
  }

  async grantKudosPoints(
    orgId: string,
    userId: string,
    sourceId: string,
  ): Promise<void> {
    await this.db.insert(hrRewardPointsLedger).values({
      orgId,
      userId,
      points: 5,
      source: "kudos",
      sourceId,
      note: "Received kudos",
    });
  }
}
