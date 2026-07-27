import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const rewardPointSourceEnum = pgEnum("reward_point_source", [
  "kudos",
  "badge",
  "manual",
  "redemption",
]);

export const pollStatusEnum = pgEnum("hr_poll_status", ["draft", "active", "closed"]);

export const communityMemberRoleEnum = pgEnum("community_member_role", ["member", "moderator"]);

export const campaignStatusEnum = pgEnum("engagement_campaign_status", [
  "draft",
  "active",
  "completed",
  "cancelled",
]);

export const hrMoodCheckins = pgTable(
  "hr_mood_checkins",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    date: text("date").notNull(),
    mood: integer("mood").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_mood_checkins_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_mood_org_user_date").on(t.orgId, t.userId, t.date),
    index("idx_mood_checkins_org_date").on(t.orgId, t.date),
  ],
);

export const hrBadges = pgTable(
  "hr_badges",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    icon: text("icon").notNull(),
    points: integer("points").default(10).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_badges_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_badge_org_name").on(t.orgId, t.name),
    index("idx_badges_org").on(t.orgId),
  ],
);

export const hrBadgeAwards = pgTable("hr_badge_awards", {
  id: serial("id").primaryKey(),
  orgId: text("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  badgeId: integer("badge_id")
    .references(() => hrBadges.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  awardedBy: text("awarded_by")
    .references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("uniq_hr_badge_awards_org_id").on(t.orgId, t.id),
  index("idx_badge_awards_org_user").on(t.orgId, t.userId),
  index("idx_badge_awards_badge").on(t.badgeId),
]);

export const hrRewardPointsLedger = pgTable("hr_reward_points_ledger", {
  id: serial("id").primaryKey(),
  orgId: text("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  points: integer("points").notNull(),
  source: rewardPointSourceEnum("source").notNull(),
  sourceId: text("source_id"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("uniq_hr_reward_points_ledger_org_id").on(t.orgId, t.id),
  index("idx_reward_ledger_org_user").on(t.orgId, t.userId),
  index("idx_reward_ledger_org_created").on(t.orgId, t.createdAt),
]);

export const hrPolls = pgTable(
  "hr_polls",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    question: text("question").notNull(),
    options: jsonb("options").$type<string[]>().notNull(),
    status: pollStatusEnum("status").default("draft").notNull(),
    anonymous: boolean("anonymous").default(false).notNull(),
    createdBy: text("created_by")
      .references(() => users.id, { onDelete: "set null" }),
    closesAt: timestamp("closes_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_polls_org_id").on(t.orgId, t.id),
    index("idx_hr_polls_org_status").on(t.orgId, t.status),
  ],
);

export const hrPollVotes = pgTable(
  "hr_poll_votes",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .references(() => hrPolls.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    optionIndex: integer("option_index").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_poll_vote_poll_user").on(t.pollId, t.userId),
    index("idx_poll_votes_poll").on(t.pollId),
  ],
);

export const hrCommunities = pgTable(
  "hr_communities",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by")
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_hr_communities_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_community_org_name").on(t.orgId, t.name),
    index("idx_communities_org").on(t.orgId),
  ],
);

export const hrCommunityMembers = pgTable(
  "hr_community_members",
  {
    id: serial("id").primaryKey(),
    communityId: integer("community_id")
      .references(() => hrCommunities.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: communityMemberRoleEnum("role").default("member").notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_community_member").on(t.communityId, t.userId),
    index("idx_community_members_community").on(t.communityId),
    index("idx_community_members_user").on(t.userId),
  ],
);

export const hrCampaigns = pgTable("hr_campaigns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  status: campaignStatusEnum("status").default("draft").notNull(),
  audience: jsonb("audience").$type<{ type: string; ids?: string[] }>(),
  createdBy: text("created_by")
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (t) => [
  unique("uniq_hr_campaigns_org_id").on(t.orgId, t.id),
  index("idx_campaigns_org_status").on(t.orgId, t.status),
]);

export const hrMoodCheckinsRelations = relations(hrMoodCheckins, ({ one }) => ({
  user: one(users, { fields: [hrMoodCheckins.userId], references: [users.id] }),
  org: one(organizations, { fields: [hrMoodCheckins.orgId], references: [organizations.id] }),
}));

export const hrBadgesRelations = relations(hrBadges, ({ one, many }) => ({
  org: one(organizations, { fields: [hrBadges.orgId], references: [organizations.id] }),
  awards: many(hrBadgeAwards),
}));

export const hrBadgeAwardsRelations = relations(hrBadgeAwards, ({ one }) => ({
  badge: one(hrBadges, { fields: [hrBadgeAwards.badgeId], references: [hrBadges.id] }),
  user: one(users, { fields: [hrBadgeAwards.userId], references: [users.id], relationName: "awardedToUser" }),
  awardedByUser: one(users, { fields: [hrBadgeAwards.awardedBy], references: [users.id], relationName: "awardedByUser" }),
}));

export const hrRewardPointsLedgerRelations = relations(hrRewardPointsLedger, ({ one }) => ({
  user: one(users, { fields: [hrRewardPointsLedger.userId], references: [users.id] }),
}));

export const hrPollsRelations = relations(hrPolls, ({ one, many }) => ({
  creator: one(users, { fields: [hrPolls.createdBy], references: [users.id] }),
  votes: many(hrPollVotes),
}));

export const hrPollVotesRelations = relations(hrPollVotes, ({ one }) => ({
  poll: one(hrPolls, { fields: [hrPollVotes.pollId], references: [hrPolls.id] }),
  user: one(users, { fields: [hrPollVotes.userId], references: [users.id] }),
}));

export const hrCommunitiesRelations = relations(hrCommunities, ({ one, many }) => ({
  creator: one(users, { fields: [hrCommunities.createdBy], references: [users.id] }),
  members: many(hrCommunityMembers),
}));

export const hrCommunityMembersRelations = relations(hrCommunityMembers, ({ one }) => ({
  community: one(hrCommunities, { fields: [hrCommunityMembers.communityId], references: [hrCommunities.id] }),
  user: one(users, { fields: [hrCommunityMembers.userId], references: [users.id] }),
}));

export const hrCampaignsRelations = relations(hrCampaigns, ({ one }) => ({
  creator: one(users, { fields: [hrCampaigns.createdBy], references: [users.id] }),
}));
