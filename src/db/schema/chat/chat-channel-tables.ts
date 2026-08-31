import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";
import { deals } from "../crm";

export const chatChannels = pgTable(
  "chat_channels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("GROUP"),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    isPinned: boolean("is_pinned").default(false).notNull(),
    isPrivate: boolean("is_private").default(false).notNull(),
    linkedDealId: integer("linked_deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    messageCount: bigint("message_count", { mode: "number" }).notNull().default(0),
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_chat_channels_org").on(table.orgId),
    index("idx_chat_channels_last_msg").on(table.orgId, table.lastMessageAt),
    index("idx_chat_channels_org_entity").on(
      table.orgId,
      table.entityType,
      table.entityId,
    ),
    unique("uniq_chat_channels_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_channels_org_created_by_membership" }).onDelete("set null"),
  ],
);

export const chatChannelMembers = pgTable(
  "chat_channel_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    role: text("role").default("MEMBER").notNull(),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    mutedUntil: timestamp("muted_until"),
    archivedAt: timestamp("archived_at"),
    isFavorite: boolean("is_favorite").default(false).notNull(),
    notificationPreference: text("notification_preference")
      .default("DEFAULT")
      .notNull(),
  },
  (table) => [
    uniqueIndex("uniq_chat_channel_member_membership").on(table.orgId, table.channelId, table.membershipId),
    index("idx_chat_members_channel").on(table.channelId),
    index("idx_chat_channel_members_org").on(table.orgId),
    unique("uniq_chat_channel_members_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_channel_members_org_channel" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_channel_members_org_membership" }),
  ],
);

export const chatChannelInviteLinks = pgTable(
  "chat_channel_invite_links",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    channelId: integer("channel_id")
      .references(() => chatChannels.id, { onDelete: "cascade" })
      .notNull(),
    token: text("token"),
    tokenHash: text("token_hash"),
    tokenEncrypted: text("token_encrypted"),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("uniq_chat_invite_link_token").on(table.token),
    uniqueIndex("uniq_chat_invite_link_token_hash").on(table.tokenHash),
    index("idx_chat_invite_links_channel").on(table.channelId, table.revokedAt),
    index("idx_chat_channel_invite_links_org").on(table.orgId),
    unique("uniq_chat_channel_invite_links_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_invite_links_org_channel" }),
    foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_invite_links_created_by_membership" }).onDelete("set null"),
  ],
);

export const chatOrgSettings = pgTable(
  "chat_org_settings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    defaultNotificationPreference: text("default_notification_preference")
      .default("ALL")
      .notNull(),
    maxAttachmentSizeMb: integer("max_attachment_size_mb")
      .default(25)
      .notNull(),
    maxHuddleParticipants: integer("max_huddle_participants")
      .default(50)
      .notNull(),
    updatedByMembershipId: integer("updated_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_chat_org_settings_org").on(table.orgId),
    unique("uniq_chat_org_settings_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.updatedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_org_settings_updated_by_membership" }).onDelete("set null"),
  ],
);
