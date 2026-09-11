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
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
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
    createdByMembershipId: integer("created_by_membership_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    isPinned: boolean("is_pinned").default(false).notNull(),
    isPrivate: boolean("is_private").default(false).notNull(),
    linkedDealId: integer("linked_deal_id"),
    messageCount: bigint("message_count", { mode: "number" }).notNull().default(0),
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_chat_channels_last_msg").on(table.orgId, table.lastMessageAt),
    // UNIQUE, and it is the only thing preventing two chat channels for one record.
    // `getOrCreateEntityChannel` is reached by a TanStack useQuery — a GET that writes —
    // so a StrictMode double-mount or a retry issues two concurrent requests that both
    // miss the pre-check and both insert; `createChannel` accepts entityType/entityId too
    // and does not pre-check at all, so an application-side lock could not close it.
    // Partial on `entity_type IS NOT NULL` because most channels are not attached to a
    // record and must not share one uniqueness class — the call site names that predicate
    // in its ON CONFLICT `targetWhere`, which is what keeps it inferable (see 1054).
    uniqueIndex("uniq_chat_channels_org_entity")
      .on(table.orgId, table.entityType, table.entityId)
      .where(sql`entity_type IS NOT NULL`),
    unique("uniq_chat_channels_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_channels_org_created_by_membership" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.linkedDealId], foreignColumns: [deals.orgId, deals.id], name: "fk_chat_channels_linked_deal_id_org" }).onDelete("set null"),
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
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    role: text("role").default("MEMBER").notNull(),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
    lastReadPosition: bigint("last_read_position", { mode: "number" }).notNull().default(0),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    mutedUntil: timestamp("muted_until"),
    archivedAt: timestamp("archived_at"),
    isFavorite: boolean("is_favorite").default(false).notNull(),
    notificationPreference: text("notification_preference")
      .default("DEFAULT")
      .notNull(),
  },
  (table) => [
    index("idx_chat_channel_members_org").on(table.orgId),
    uniqueIndex("uniq_chat_channel_member_membership").on(table.orgId, table.channelId, table.membershipId),
    index("idx_chat_members_channel").on(table.channelId),
    unique("uniq_chat_channel_members_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.channelId], foreignColumns: [chatChannels.orgId, chatChannels.id], name: "fk_chat_channel_members_org_channel" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_chat_channel_members_org_membership" }).onDelete("cascade"),
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
      .notNull(),
    token: text("token"),
    tokenHash: text("token_hash"),
    tokenEncrypted: text("token_encrypted"),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    expiresAt: timestamp("expires_at"),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uniq_chat_invite_link_token").on(table.token),
    uniqueIndex("uniq_chat_invite_link_token_hash").on(table.tokenHash),
    uniqueIndex("uniq_chat_invite_active_link_channel")
      .on(table.orgId, table.channelId)
      .where(sql`revoked_at IS NULL`),
    index("idx_chat_invite_links_channel").on(table.channelId, table.revokedAt),
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
