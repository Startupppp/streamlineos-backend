import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  hrMoodCheckins,
  hrPollVotes,
  hrPolls,
} from "../../../db/schema/hr/engagement-extras";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type {
  CreatePollInput,
  MoodCheckinInput,
  UpdatePollInput,
  VotePollInput,
} from "./dto/engagement-extras.schemas";

const MIN_GROUP_SIZE = 5;

@Injectable()
export class EngagementMoodPollsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async moodCheckin(u: CurrentUserContext, input: MoodCheckinInput) {
    const today = input.date ?? new Date().toISOString().slice(0, 10);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
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
        target: [hrMoodCheckins.orgId, hrMoodCheckins.userMembershipId, hrMoodCheckins.date],
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
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    return this.db
      .select({
        id: hrMoodCheckins.id,
        date: hrMoodCheckins.date,
        mood: hrMoodCheckins.mood,
        note: hrMoodCheckins.note,
      })
      .from(hrMoodCheckins)
      .where(and(eq(hrMoodCheckins.orgId, u.orgId), eq(hrMoodCheckins.userMembershipId, membershipId)))
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

  async votePoll(
    orgId: string,
    userId: string,
    pollId: number,
    input: VotePollInput,
  ) {
    const [poll] = await this.db
      .select()
      .from(hrPolls)
      .where(and(eq(hrPolls.id, pollId), eq(hrPolls.orgId, orgId)));
    if (!poll) throw new NotFoundException("Poll not found.");
    if (poll.status !== "active")
      throw new BadRequestException("Poll is not active.");
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
}
