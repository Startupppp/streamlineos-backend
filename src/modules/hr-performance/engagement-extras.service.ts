import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql, sum } from "drizzle-orm";
import { hrAuditLogs, recognitions } from "../../db/schema";
import {
  hrBadgeAwards,
  hrBadges,
  hrCampaigns,
  hrCommunities,
  hrCommunityMembers,
  hrMoodCheckins,
  hrPollVotes,
  hrPolls,
  hrRewardPointsLedger,
} from "../../db/schema/hr/engagement-extras";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  AwardBadgeInput,
  CreateBadgeInput,
  CreateCampaignInput,
  CreateCommunityInput,
  CreatePollInput,
  MoodCheckinInput,
  UpdateCampaignInput,
  UpdatePollInput,
  VotePollInput,
} from "./dto/engagement-extras.schemas";

const MIN_GROUP_SIZE = 5;

@Injectable()
export class EngagementExtrasService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async moodCheckin(orgId: string, userId: string, input: MoodCheckinInput) {
    const today = input.date ?? new Date().toISOString().slice(0, 10);
    const [row] = await this.db
      .insert(hrMoodCheckins)
      .values({ orgId, userId, date: today, mood: input.mood, note: input.note ?? null })
      .onConflictDoUpdate({
        target: [hrMoodCheckins.orgId, hrMoodCheckins.userId, hrMoodCheckins.date],
        set: { mood: input.mood, note: input.note ?? null },
      })
      .returning();
    return row;
  }

  myMoodHistory(orgId: string, userId: string, limit = 30) {
    return this.db
      .select({
        id: hrMoodCheckins.id,
        date: hrMoodCheckins.date,
        mood: hrMoodCheckins.mood,
        note: hrMoodCheckins.note,
      })
      .from(hrMoodCheckins)
      .where(and(eq(hrMoodCheckins.orgId, orgId), eq(hrMoodCheckins.userId, userId)))
      .orderBy(desc(hrMoodCheckins.createdAt))
      .limit(limit);
  }

  async orgMoodAggregate(orgId: string) {
    const rows = await this.db
      .select({ date: hrMoodCheckins.date, mood: hrMoodCheckins.mood })
      .from(hrMoodCheckins)
      .where(eq(hrMoodCheckins.orgId, orgId))
      .orderBy(desc(hrMoodCheckins.createdAt))
      .limit(100);

    const byDate = new Map<string, number[]>();
    for (const r of rows) {
      const existing = byDate.get(r.date) ?? [];
      existing.push(r.mood);
      byDate.set(r.date, existing);
    }

    const result: { date: string; avgMood: number; count: number }[] = [];
    for (const [date, moods] of byDate.entries()) {
      if (moods.length < MIN_GROUP_SIZE) continue;
      const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
      result.push({ date, avgMood: Math.round(avg * 10) / 10, count: moods.length });
    }
    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }

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

  async awardBadge(orgId: string, awardedBy: string, badgeId: number, input: AwardBadgeInput) {
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

      await tx.insert(hrAuditLogs).values({
        orgId,
        actorId: awardedBy,
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
      .where(and(eq(hrBadgeAwards.orgId, orgId), eq(hrBadgeAwards.userId, userId)))
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

  listPolls(orgId: string) {
    return this.db
      .select()
      .from(hrPolls)
      .where(eq(hrPolls.orgId, orgId))
      .orderBy(desc(hrPolls.createdAt))
      .limit(100);
  }

  async createPoll(orgId: string, userId: string, input: CreatePollInput) {
    const [poll] = await this.db
      .insert(hrPolls)
      .values({
        orgId,
        question: input.question,
        options: input.options,
        anonymous: input.anonymous ?? false,
        createdBy: userId,
        closesAt: input.closesAt ? new Date(input.closesAt) : null,
      })
      .returning();
    return poll;
  }

  async updatePoll(orgId: string, pollId: number, input: UpdatePollInput) {
    const [poll] = await this.db
      .select({ id: hrPolls.id })
      .from(hrPolls)
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    if (!poll) throw new NotFoundException("Poll not found.");

    await this.db
      .update(hrPolls)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.question !== undefined && { question: input.question }),
      })
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    return { success: true };
  }

  async votePoll(orgId: string, userId: string, pollId: number, input: VotePollInput) {
    const [poll] = await this.db
      .select()
      .from(hrPolls)
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    if (!poll) throw new NotFoundException("Poll not found.");
    if (poll.status !== "active") throw new BadRequestException("Poll is not active.");
    if (poll.closesAt && poll.closesAt < new Date())
      throw new BadRequestException("Poll has closed.");
    const opts = poll.options as string[];
    if (input.optionIndex < 0 || input.optionIndex >= opts.length) {
      throw new BadRequestException("Invalid option index.");
    }

    const [vote] = await this.db
      .insert(hrPollVotes)
      .values({ pollId, userId, optionIndex: input.optionIndex })
      .returning()
      .catch(() => {
        throw new ConflictException("You have already voted on this poll.");
      });
    return vote;
  }

  async pollResults(orgId: string, pollId: number) {
    const [poll] = await this.db
      .select()
      .from(hrPolls)
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    if (!poll) throw new NotFoundException("Poll not found.");

    const votes = await this.db
      .select({ optionIndex: hrPollVotes.optionIndex })
      .from(hrPollVotes)
      .where(eq(hrPollVotes.pollId, pollId));

    const opts = poll.options as string[];
    const counts = opts.map((option, idx) => ({
      option,
      optionIndex: idx,
      count: votes.filter((v) => v.optionIndex === idx).length,
    }));

    return {
      pollId,
      question: poll.question,
      anonymous: poll.anonymous,
      status: poll.status,
      totalVotes: votes.length,
      counts,
    };
  }

  async listCommunities(orgId: string) {
    const communities = await this.db
      .select()
      .from(hrCommunities)
      .where(eq(hrCommunities.orgId, orgId))
      .orderBy(desc(hrCommunities.createdAt))
      .limit(100);

    if (communities.length === 0) return [];

    const ids = communities.map((c) => c.id);
    const members = await this.db
      .select({
        communityId: hrCommunityMembers.communityId,
        userId: hrCommunityMembers.userId,
        role: hrCommunityMembers.role,
      })
      .from(hrCommunityMembers)
      .where(inArray(hrCommunityMembers.communityId, ids));

    const membersByComm = new Map<number, { userId: string; role: string }[]>();
    for (const m of members) {
      const list = membersByComm.get(m.communityId) ?? [];
      list.push({ userId: m.userId, role: m.role });
      membersByComm.set(m.communityId, list);
    }

    return communities.map((c) => ({
      ...c,
      members: membersByComm.get(c.id) ?? [],
    }));
  }

  async createCommunity(orgId: string, userId: string, input: CreateCommunityInput) {
    return this.db.transaction(async (tx) => {
      const [community] = await tx
        .insert(hrCommunities)
        .values({
          orgId,
          name: input.name,
          description: input.description ?? null,
          createdBy: userId,
        })
        .returning()
        .catch(() => {
          throw new ConflictException(`Community "${input.name}" already exists.`);
        });

      await tx.insert(hrCommunityMembers).values({
        communityId: community.id,
        userId,
        role: "moderator",
      });

      return community;
    });
  }

  async joinCommunity(orgId: string, userId: string, communityId: number) {
    const [community] = await this.db
      .select({ id: hrCommunities.id })
      .from(hrCommunities)
      .where(and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)));
    if (!community) throw new NotFoundException("Community not found.");

    await this.db
      .insert(hrCommunityMembers)
      .values({ communityId, userId, role: "member" })
      .catch(() => {
        throw new ConflictException("Already a member.");
      });

    return { success: true };
  }

  async leaveCommunity(orgId: string, userId: string, communityId: number) {
    const [community] = await this.db
      .select({ id: hrCommunities.id })
      .from(hrCommunities)
      .where(and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)));
    if (!community) throw new NotFoundException("Community not found.");

    await this.db
      .delete(hrCommunityMembers)
      .where(
        and(
          eq(hrCommunityMembers.communityId, communityId),
          eq(hrCommunityMembers.userId, userId),
        ),
      );
    return { success: true };
  }

  async communityMembers(orgId: string, communityId: number) {
    const [community] = await this.db
      .select()
      .from(hrCommunities)
      .where(and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)));
    if (!community) throw new NotFoundException("Community not found.");

    const members = await this.db
      .select({ userId: hrCommunityMembers.userId, role: hrCommunityMembers.role })
      .from(hrCommunityMembers)
      .where(eq(hrCommunityMembers.communityId, communityId));

    return { ...community, members };
  }

  listCampaigns(orgId: string) {
    return this.db
      .select()
      .from(hrCampaigns)
      .where(eq(hrCampaigns.orgId, orgId))
      .orderBy(desc(hrCampaigns.createdAt))
      .limit(100);
  }

  async createCampaign(orgId: string, userId: string, input: CreateCampaignInput) {
    const [campaign] = await this.db
      .insert(hrCampaigns)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        status: input.status ?? "draft",
        audience: input.audience ?? null,
        createdBy: userId,
      })
      .returning();
    return campaign;
  }

  async updateCampaign(orgId: string, campaignId: number, input: UpdateCampaignInput) {
    const [campaign] = await this.db
      .select({ id: hrCampaigns.id })
      .from(hrCampaigns)
      .where(and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)));
    if (!campaign) throw new NotFoundException("Campaign not found.");

    const [updated] = await this.db
      .update(hrCampaigns)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.startsAt !== undefined && { startsAt: new Date(input.startsAt) }),
        ...(input.endsAt !== undefined && { endsAt: new Date(input.endsAt) }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.audience !== undefined && { audience: input.audience }),
      })
      .where(and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteCampaign(orgId: string, campaignId: number) {
    const [campaign] = await this.db
      .select({ id: hrCampaigns.id })
      .from(hrCampaigns)
      .where(and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)));
    if (!campaign) throw new NotFoundException("Campaign not found.");

    await this.db
      .delete(hrCampaigns)
      .where(and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)));
    return { success: true };
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

  async grantKudosPoints(orgId: string, userId: string, sourceId: string) {
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
