import { z } from "zod";
import { campaignStatusEnum } from "../../../../db/schema/hr/engagement-extras";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const moodCheckinSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  date: z.string(),
  mood: z.number().int(),
  note: z.string().nullable(),
  createdAt: wireDate(),
});

export const moodCheckinResponseSchema = moodCheckinSchema;

export const myMoodHistoryResponseSchema = z.array(z.object({
  id: z.number().int(),
  date: z.string(),
  mood: z.number().int(),
  note: z.string().nullable(),
}));

export const orgMoodAggregateResponseSchema = z.array(z.object({
  date: z.string(),
  avgMood: z.number(),
  count: z.number().int(),
}));

const pollSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  status: z.enum(["draft", "active", "closed"]),
  anonymous: z.boolean(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  closesAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const listPollsResponseSchema = z.array(pollSchema);
export const createPollResponseSchema = pollSchema;
export const updatePollResponseSchema = successSchema;

const pollVoteSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  pollId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  optionIndex: z.number().int(),
  createdAt: wireDate(),
});

export const votePollResponseSchema = pollVoteSchema;

export const pollResultsResponseSchema = z.object({
  pollId: z.number().int(),
  question: z.string(),
  anonymous: z.boolean(),
  status: z.enum(["draft", "active", "closed"]),
  totalVotes: z.number().int(),
  counts: z.array(z.object({ option: z.string(), optionIndex: z.number().int(), count: z.number().int() })),
});

const communitySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCommunitiesResponseSchema = z.object({
  items: z.array(communitySchema.extend({ members: z.array(z.object({ userId: z.string(), role: z.enum(["member", "moderator"]) })) })),
  nextCursor: z.string().nullable(),
});

export const createCommunityResponseSchema = communitySchema;
export const joinCommunityResponseSchema = successSchema;
export const leaveCommunityResponseSchema = successSchema;

export const communityMembersResponseSchema = communitySchema.extend({
  membersTruncated: z.boolean(),
  members: z.array(z.object({ userId: z.string(), role: z.enum(["member", "moderator"]) })),
});

const campaignSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  startsAt: nullableWireDate(),
  endsAt: nullableWireDate(),
  status: z.enum(campaignStatusEnum.enumValues),
  audience: z.object({ type: z.string(), ids: z.array(z.string()).optional() }).nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listCampaignsResponseSchema = z.array(campaignSchema);
export const createCampaignResponseSchema = campaignSchema;
export const updateCampaignResponseSchema = campaignSchema;

const badgeSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  points: z.number().int(),
  createdAt: wireDate(),
});

export const listBadgesResponseSchema = z.array(badgeSchema);
export const createBadgeResponseSchema = badgeSchema;

const badgeAwardSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  badgeId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  awardedBy: z.string().nullable(),
  awardedByMembershipId: z.number().int().nullable(),
  reason: z.string().nullable(),
  createdAt: wireDate(),
});

export const awardBadgeResponseSchema = badgeAwardSchema;

export const myBadgesResponseSchema = z.array(z.object({
  id: z.number().int(),
  badgeId: z.number().int(),
  userId: z.string(),
  awardedBy: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: wireDate(),
  badge: z.object({ id: z.number().int(), name: z.string(), description: z.string(), icon: z.string(), points: z.number().int() }).nullable(),
}));

export const myPointsResponseSchema = z.array(z.object({
  id: z.number().int(),
  points: z.number().int(),
  source: z.enum(["kudos", "badge", "manual", "redemption"]),
  note: z.string().nullable(),
  createdAt: wireDate(),
}));

export const leaderboardResponseSchema = z.array(z.object({
  userId: z.string(),
  total: z.number().int(),
}));

export const employeeOfMonthResponseSchema = z.object({
  period: z.string(),
  top: z.object({
    userId: z.string(),
    recognitions: z.number().int(),
    points: z.number().int(),
    score: z.number().int(),
  }).nullable(),
});

export const overviewResponseSchema = z.object({
  employeeOfMonth: employeeOfMonthResponseSchema,
  topLeaderboard: leaderboardResponseSchema,
});
