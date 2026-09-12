import { pgTable, text, serial, timestamp, boolean, jsonb, integer, bigint, index, unique, uniqueIndex, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  notificationTypeEnum,
  notificationPriorityEnum,
  notificationCategoryEnum,
  notificationChannelEnum,
  templateApprovalStatusEnum,
} from "./enums";
import { organizations, users, organizationMembers } from "./auth";

export const notifications = pgTable("notifications", {
  // SCH-001: was serial (int4). int4 caps at 2.1bn, reachable by a fan-out-on-write
  // feed at the stated scale; widened while the table held 3 rows.
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  // Historical delivery address projection. membershipId is the recipient authority.
  userId: text("user_id"),
  membershipId: integer("membership_id"),
  type: notificationTypeEnum("type").default("INFO").notNull(),
  priority: notificationPriorityEnum("priority").default("NORMAL").notNull(),
  category: notificationCategoryEnum("category").default("SYSTEM").notNull(),
  sourceModule: text("source_module"),
  eventKey: text("event_key"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"),
  isRead: boolean("is_read").default(false).notNull(),
  pinned: boolean("pinned").default(false).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  channel: text("channel").default("IN_APP").notNull(),
  sound: boolean("sound").default(false).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  // C21-03: idx_notifications_org_user_unread (is_read + created_at) replaced by two
  // purpose-built indexes that match the actual query shape (ORDER BY id DESC).
  // idx_notifications_list_cursor: cursor pagination for list endpoints.
  index("idx_notifications_list_cursor")
    .on(table.orgId, table.membershipId, table.id.desc())
    .where(sql`deleted_at IS NULL AND archived_at IS NULL`),
  // 1093 — idx_notifications_list_created_cursor: the unified inbox orders by
  // (created_at DESC, id DESC), which idx_notifications_list_cursor cannot serve.
  index("idx_notifications_list_created_cursor")
    .on(table.orgId, table.membershipId, table.createdAt.desc(), table.id.desc())
    .where(sql`deleted_at IS NULL AND archived_at IS NULL`),
  // idx_notifications_unread_count: partial on is_read=false so the count seeks
  // past the watermark and counts only newly-arrived unread rows.
  index("idx_notifications_unread_count")
    .on(table.orgId, table.membershipId, table.id)
    .where(sql`deleted_at IS NULL AND archived_at IS NULL AND is_read = false`),
  index("idx_notifications_org_created").on(table.orgId, table.createdAt),
  index("idx_notifications_org_membership_archived").on(table.orgId, table.membershipId, table.archivedAt),
  index("idx_notifications_org_category").on(table.orgId, table.category),
  index("idx_notifications_dedupe").on(table.orgId, table.eventKey, table.entityType, table.entityId),
  index("idx_notifications_org_user_active")
    .on(table.orgId, table.membershipId, table.id)
    .where(sql`deleted_at IS NULL`),
  primaryKey({ name: "notifications_pkey", columns: [table.id, table.createdAt] }),
  unique("uniq_notifications_org_id").on(table.orgId, table.id, table.createdAt),
  foreignKey({
    name: "fk_notifications_recipient_membership",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const notificationReadWatermarks = pgTable(
  "notification_read_watermarks",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").notNull(),
    membershipId: integer("membership_id").notNull(),
    lastReadNotificationId: bigint("last_read_notification_id", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_notification_read_watermarks_org_membership").on(t.orgId, t.membershipId),
    unique("uniq_notification_read_watermarks_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_notification_read_watermarks_membership",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const notificationTemplates = pgTable("notification_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  templateKey: text("template_key").notNull(),
  name: text("name").notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  category: notificationCategoryEnum("category").default("SYSTEM").notNull(),
  locale: text("locale").default("en").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  variables: jsonb("variables").$type<string[]>().default([]).notNull(),
  version: integer("version").default(1).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  // COMP-005: WhatsApp (and any other channel requiring pre-registered content) cannot
  // send a template the provider has not approved. Modelling the state here means the
  // send is refused before the provider call rather than rejected per message.
  approvalStatus: templateApprovalStatusEnum("approval_status").default("NOT_REQUIRED").notNull(),
  providerTemplateName: text("provider_template_name"),
  approvalCheckedAt: timestamp("approval_checked_at", { withTimezone: true }),
  approvalRejectionReason: text("approval_rejection_reason"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_notification_templates_key_locale_version").on(table.orgId, table.templateKey, table.locale, table.version),
  index("idx_notification_templates_channel").on(table.channel),
  index("idx_notification_templates_active").on(table.isActive),
  unique("uniq_notification_templates_org_id").on(table.orgId, table.id),
]);

export const notificationAuditLogs = pgTable("notification_audit_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  notificationId: bigint("notification_id", { mode: "number" }),
  notificationCreatedAt: timestamp("notification_created_at", { withTimezone: true }),
  broadcastId: integer("broadcast_id"),
  actorId: text("actor_id").references(() => users.id),
  action: text("action").notNull(),
  sourceModule: text("source_module"),
  channel: text("channel"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  // SCH-005: staleness signal. Without it a dead subscription has no evidence
  // other than a 410 from the push service.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    name: "notification_audit_logs_notification_fk",
    columns: [table.notificationId, table.notificationCreatedAt],
    foreignColumns: [notifications.id, notifications.createdAt],
  }).onDelete("set null"),
  index("idx_notif_audit_org_action").on(table.orgId, table.action),
  index("idx_notif_audit_org_created").on(table.orgId, table.createdAt),
  unique("uniq_notification_audit_logs_org_id").on(table.orgId, table.id),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  membershipId: integer("membership_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  emailEnabled: boolean("email_enabled").default(true).notNull(),
  pushEnabled: boolean("push_enabled").default(true).notNull(),
  smsEnabled: boolean("sms_enabled").default(false).notNull(),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  whatsappEnabled: boolean("whatsapp_enabled").default(false).notNull(),
  soundEnabled: boolean("sound_enabled").default(true).notNull(),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  // SCH-012: no longer read. Quiet hours resolve from user_preferences.timezone,
  // which is NOT NULL and defaults Asia/Kolkata; this defaulted UTC, so an IST
  // user's window was applied 5.5h out. Retained for the expand-contract window;
  // dropped once nothing reads it.
  digestMode: text("digest_mode").$type<"disabled" | "hourly" | "daily" | "weekly">().default("disabled").notNull(),
  quietHoursWeekends: boolean("quiet_hours_weekends").default(true).notNull(),
  allowCriticalOverride: boolean("allow_critical_override").default(true).notNull(),
  categories: jsonb("categories").$type<Record<string, boolean>>().default({}).notNull(),
  channelCategories: jsonb("channel_categories").$type<Record<string, Record<string, boolean>>>().default({}).notNull(),
  eventPreferences: jsonb("event_preferences").$type<Record<string, { channels?: Record<string, boolean>; muted?: boolean; mode?: string }>>().default({}).notNull(),
  modulePreferences: jsonb("module_preferences").$type<Record<string, { mode?: string; muted?: boolean }>>().default({}).notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_notification_preferences_org_id").on(table.orgId, table.id),
  // SCH-011: was a bare UNIQUE(user_id), so a user in two orgs shared one row and
  // the second org's write overwrote the first.
  uniqueIndex("uniq_notification_preferences_org_membership").on(table.orgId, table.membershipId),
  foreignKey({
    name: "fk_notification_preferences_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  membership: one(organizationMembers, {
    fields: [notifications.orgId, notifications.membershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  organization: one(organizations, { fields: [notifications.orgId], references: [organizations.id] }),
}));

export const notificationTemplatesRelations = relations(notificationTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [notificationTemplates.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [notificationTemplates.createdBy], references: [users.id] }),
}));

export const notificationAuditLogsRelations = relations(notificationAuditLogs, ({ one }) => ({
  organization: one(organizations, { fields: [notificationAuditLogs.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [notificationAuditLogs.actorId], references: [users.id] }),
}));
