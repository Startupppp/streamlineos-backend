import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { chatChannels } from "./chat-channel-tables";

export const chatUserPresence = pgTable(
  "chat_user_presence",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    status: text("status").default("OFFLINE").notNull(),
    statusMessage: text("status_message"),
    statusExpiresAt: timestamp("status_expires_at"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_presence_org_membership").on(table.orgId, table.membershipId),
    index("idx_chat_presence_org").on(table.orgId, table.status),
    index("idx_chat_presence_lastseen").on(table.orgId, table.lastSeenAt),
    unique("uniq_chat_user_presence_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_chat_user_presence_org_membership",
    }).onDelete("cascade"),
  ],
);

export const chatHuddles = pgTable(
  "chat_huddles",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .notNull(),
    startedByMembershipId: integer("started_by_membership_id").notNull(),
    status: text("status").default("active").notNull(),
    calendarEventId: integer("calendar_event_id"),
    meetingUrl: text("meeting_url"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("idx_chat_huddles_channel").on(table.channelId, table.status),
    unique("uniq_chat_huddles_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_huddles_org_channel" }),
    foreignKey({ columns: [table.orgId, table.startedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_huddles_org_starter_membership" }).onDelete("cascade"),
  ],
);

export const chatHuddleParticipants = pgTable(
  "chat_huddle_participants",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    huddleId: integer("huddle_id")
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    leftAt: timestamp("left_at"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_huddle_participant").on(table.huddleId, table.membershipId),
    unique("uniq_chat_huddle_participants_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.huddleId], foreignColumns: [chatHuddles.orgId, chatHuddles.id], name: "fk_chat_huddle_participants_org_huddle" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_huddle_participants_org_membership" }).onDelete("cascade"),
  ],
);
