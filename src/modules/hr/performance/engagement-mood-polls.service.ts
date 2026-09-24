import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import {
  hrMoodCheckins,
  hrPollVotes,
  hrPolls,
} from "../../../db/schema/hr/engagement-extras";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  pollOptionsSchema,
  type CreatePollInput,
  type MoodCheckinInput,
  type UpdatePollInput,
  type VotePollInput,
} from "./dto/engagement-extras.schemas";
import { hasPatchValues } from "../../../common/db/patch-values";
import {
  ANONYMITY_MIN_RESPONSES,
  isBelowAnonymityThreshold,
} from "../../../common/privacy/anonymity-threshold";

@Injectable()
export class EngagementMoodPollsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async moodCheckin(u: CurrentUserContext, input: MoodCheckinInput) {
    const today = input.date ?? new Date().toISOString().slice(0, 10);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new ForbiddenException("Organization membership required");
    const [row] = await this.db
      .insert(hrMoodCheckins)
      .values({
        orgId: u.orgId,
        userId: u.userId,
        userMembershipId: membershipId,
        date: today,
        mood: input.mood,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: [
          hrMoodCheckins.orgId,
          hrMoodCheckins.userMembershipId,
          hrMoodCheckins.date,
        ],
        set: {
          mood: input.mood,
          note: input.note ?? null,
          userMembershipId: membershipId,
        },
      })
      .returning();
    return row;
  }

  myMoodHistory(u: CurrentUserContext, limit = 30) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new ForbiddenException("Organization membership required");
    return this.db
      .select({
        id: hrMoodCheckins.id,
        date: hrMoodCheckins.date,
        mood: hrMoodCheckins.mood,
        note: hrMoodCheckins.note,
      })
      .from(hrMoodCheckins)
      .where(
        and(
          eq(hrMoodCheckins.orgId, u.orgId),
          eq(hrMoodCheckins.userMembershipId, membershipId),
        ),
      )
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

    const points: { date: string; avgMood: number; count: number }[] = [];
    let suppressedDays = 0;
    for (const [date, moods] of byDate.entries()) {
      if (isBelowAnonymityThreshold(moods.length)) {
        suppressedDays += 1;
        continue;
      }
      const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
      points.push({
        date,
        avgMood: Math.round(avg * 10) / 10,
        count: moods.length,
      });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return { minResponses: ANONYMITY_MIN_RESPONSES, suppressedDays, points };
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
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)))
      .limit(1);
    if (!poll) throw new NotFoundException("Poll not found.");

    const values = {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.question !== undefined && { question: input.question }),
    };
    if (hasPatchValues(values))
      await this.db
        .update(hrPolls)
        .set(values)
        .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    return { success: true };
  }

  async votePoll(
    orgId: string,
    userId: string,
    pollId: number,
    input: VotePollInput,
  ) {
    const [poll] = await this.db
      .select()
      .from(hrPolls)
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)))
      .limit(1);
    if (!poll) throw new NotFoundException("Poll not found.");
    if (poll.status !== "active")
      throw new BadRequestException("Poll is not active.");
    if (poll.closesAt && poll.closesAt < new Date())
      throw new BadRequestException("Poll has closed.");
    const optsParsed = pollOptionsSchema.safeParse(poll.options);
    const opts = optsParsed.success ? optsParsed.data : [];
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
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)))
      .limit(1);
    if (!poll) throw new NotFoundException("Poll not found.");

    const votes = await this.db
      .select({ optionIndex: hrPollVotes.optionIndex, count: count() })
      .from(hrPollVotes)
      .where(eq(hrPollVotes.pollId, pollId))
      .groupBy(hrPollVotes.optionIndex);

    const optsParsed = pollOptionsSchema.safeParse(poll.options);
    const opts = optsParsed.success ? optsParsed.data : [];
    const totalVotes = votes.reduce((total, vote) => total + Number(vote.count), 0);
    const suppressed = poll.anonymous && totalVotes > 0 && isBelowAnonymityThreshold(totalVotes);
    const counts = suppressed
      ? null
      : opts.map((option, idx) => ({
          option,
          optionIndex: idx,
          count: Number(votes.find((v) => v.optionIndex === idx)?.count ?? 0),
        }));

    return {
      pollId,
      question: poll.question,
      anonymous: poll.anonymous,
      status: poll.status,
      totalVotes,
      minResponses: ANONYMITY_MIN_RESPONSES,
      suppressed,
      counts,
    };
  }
}
