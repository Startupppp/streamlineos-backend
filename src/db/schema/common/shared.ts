
import { pgTable, text, serial, timestamp, boolean, jsonb, integer, bigint, index, unique, uniqueIndex, numeric, varchar } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  notificationTypeEnum,
  notificationPriorityEnum,
  notificationCategoryEnum,
  broadcastStatusEnum,
  notificationChannelEnum,
  subscriptionStatusEnum,
  subscriptionPlanEnum,
  broadcastAudienceTypeEnum,
  templateApprovalStatusEnum,
} from "./enums";
import { organizations, users } from "./auth";

export const notifications = pgTable("notifications", {
  // SCH-001: was serial (int4). int4 caps at 2.1bn, reachable by a fan-out-on-write
  // feed at the stated scale; widened while the table held 3 rows.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
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
    .on(table.orgId, table.userId, table.id.desc())
    .where(sql`deleted_at IS NULL AND archived_at IS NULL`),
  // idx_notifications_unread_count: partial on is_read=false so the count seeks
  // past the watermark and counts only newly-arrived unread rows.
  index("idx_notifications_unread_count")
    .on(table.orgId, table.userId, table.id)
    .where(sql`deleted_at IS NULL AND archived_at IS NULL AND is_read = false`),
  index("idx_notifications_org_created").on(table.orgId, table.createdAt),
  index("idx_notifications_user_archived").on(table.userId, table.archivedAt),
  index("idx_notifications_org_category").on(table.orgId, table.category),
  index("idx_notifications_dedupe").on(table.orgId, table.eventKey, table.entityType, table.entityId),
  index("idx_notifications_org_user_active")
    .on(table.orgId, table.userId, table.id)
    .where(sql`deleted_at IS NULL`),
  unique("uniq_notifications_org_id").on(table.orgId, table.id),
]);

export const notificationReadWatermarks = pgTable(
  "notification_read_watermarks",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    lastReadNotificationId: bigint("last_read_notification_id", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_notification_read_watermarks_org_user").on(t.orgId, t.userId),
    unique("uniq_notification_read_watermarks_org_id").on(t.orgId, t.id),
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
  index("idx_notification_templates_org").on(table.orgId),
  index("idx_notification_templates_channel").on(table.channel),
  index("idx_notification_templates_active").on(table.isActive),
  unique("uniq_notification_templates_org_id").on(table.orgId, table.id),
]);

export const broadcasts = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: notificationTypeEnum("type").default("INFO").notNull(),
  priority: notificationPriorityEnum("priority").default("NORMAL").notNull(),
  category: notificationCategoryEnum("category").default("SYSTEM").notNull(),
  channels: jsonb("channels").$type<string[]>().default(["IN_APP"]).notNull(),
  // SCH-017: the ids now live in broadcast_audience_targets and the discriminator in
  // audienceType. This column is still written during expand-contract; it is no longer
  // read to resolve recipients.
  audience: jsonb("audience").$type<{
    type: "all" | "roles" | "departments" | "users";
    roleIds?: string[];
    departmentIds?: string[];
    userIds?: string[];
  }>().notNull(),
  audienceType: broadcastAudienceTypeEnum("audience_type").default("all").notNull(),
  status: broadcastStatusEnum("status").default("DRAFT").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  recipientCount: integer("recipient_count").default(0).notNull(),
  deliveredCount: integer("delivered_count").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_broadcasts_org_status").on(table.orgId, table.status),
  index("idx_broadcasts_scheduled").on(table.scheduledAt),
  index("idx_broadcasts_created_by").on(table.createdBy),
  unique("uniq_broadcasts_org_id").on(table.orgId, table.id),
]);

export const notificationAuditLogs = pgTable("notification_audit_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  notificationId: integer("notification_id").references(() => notifications.id, { onDelete: "set null" }),
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
  index("idx_notif_audit_org_action").on(table.orgId, table.action),
  index("idx_notif_audit_org_created").on(table.orgId, table.createdAt),
  index("idx_notif_audit_notification").on(table.notificationId),
  unique("uniq_notification_audit_logs_org_id").on(table.orgId, table.id),
]);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  orgId: text("org_id").references(() => organizations.id),
  targetId: text("target_id"),
  targetType: text("target_type"),
  actorUserId: text("actor_user_id"),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_logs_user_id").on(table.userId),
  index("idx_audit_logs_org_id").on(table.orgId),
  index("idx_audit_logs_action").on(table.action),
  index("idx_audit_logs_created_at").on(table.createdAt),
  index("idx_audit_logs_org_created").on(table.orgId, table.createdAt),
  index("idx_audit_logs_org_action").on(table.orgId, table.action),
  index("idx_audit_logs_resource").on(table.orgId, table.resourceType, table.createdAt),
  index("idx_audit_logs_org_module_created").on(
    table.orgId,
    sql`(${table.metadata}->>'moduleKey')`,
    table.createdAt.desc(),
  ),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_push_subs_user").on(table.userId),
  unique("uniq_push_subscriptions_org_id").on(table.orgId, table.id),
]);

export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  meetingUrl: text("meeting_url"),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  allDay: boolean("all_day").default(false).notNull(),
  color: text("color"),
  category: text("category").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  attendeeIds: jsonb("attendee_ids").$type<string[]>().default([]).notNull(),
  isRecurring: boolean("is_recurring").default(false).notNull(),
  recurringRule: text("recurring_rule"),
  agenda: text("agenda"),
  postMeetingNotes: text("post_meeting_notes"),
  linkedDealId: integer("linked_deal_id"),
  linkedLeadId: integer("linked_lead_id"),
  reminder15MinSent: boolean("reminder_15min_sent").default(false).notNull(),
  integrationConnectionId: integer("integration_connection_id"),
  externalEventId: text("external_event_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_calendar_events_org_date").on(table.orgId, table.startDate),
  index("idx_calendar_events_category").on(table.category),
  index("idx_calendar_events_created_by").on(table.createdBy),
  index("idx_calendar_events_external").on(table.integrationConnectionId, table.externalEventId),
  unique("uniq_calendar_events_org_id").on(table.orgId, table.id),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
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
  uniqueIndex("uniq_notification_preferences_org_user").on(table.orgId, table.userId),
]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  description: text("description"),
  events: jsonb("events").$type<string[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_webhook_endpoints_org").on(table.orgId),
  unique("uniq_webhook_endpoints_org_id").on(table.orgId, table.id),
]);

export const webhookLogs = pgTable("webhook_logs", {
  id: serial("id").primaryKey(),
  endpointId: integer("endpoint_id").references(() => webhookEndpoints.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  attempt: integer("attempt").default(1).notNull(),
  success: boolean("success").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_webhook_logs_endpoint").on(table.endpointId),
  index("idx_webhook_logs_org_event").on(table.orgId, table.event),
  unique("uniq_webhook_logs_org_id").on(table.orgId, table.id),
]);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  organization: one(organizations, { fields: [notifications.orgId], references: [organizations.id] }),
}));

export const notificationTemplatesRelations = relations(notificationTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [notificationTemplates.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [notificationTemplates.createdBy], references: [users.id] }),
}));

export const broadcastsRelations = relations(broadcasts, ({ one }) => ({
  organization: one(organizations, { fields: [broadcasts.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [broadcasts.createdBy], references: [users.id] }),
}));

export const notificationAuditLogsRelations = relations(notificationAuditLogs, ({ one }) => ({
  organization: one(organizations, { fields: [notificationAuditLogs.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [notificationAuditLogs.actorId], references: [users.id] }),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, { fields: [pushSubscriptions.userId], references: [users.id] }),
}));

export const eventAttendees = pgTable("event_attendees", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("event_attendees_event_user_unique").on(table.eventId, table.userId),
  index("idx_event_attendees_event_id").on(table.eventId),
  index("idx_event_attendees_user_id").on(table.userId),
]);

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  organization: one(organizations, { fields: [calendarEvents.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [calendarEvents.createdBy], references: [users.id] }),
  attendees: many(eventAttendees),
}));

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(calendarEvents, { fields: [eventAttendees.eventId], references: [calendarEvents.id] }),
  user: one(users, { fields: [eventAttendees.userId], references: [users.id] }),
}));

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  plan: subscriptionPlanEnum("plan").default("STARTER").notNull(),
  status: subscriptionStatusEnum("status").default("TRIAL").notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  razorpayCustomerId: text("razorpay_customer_id"),
  razorpayPlanId: text("razorpay_plan_id"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  trialEndsAt: timestamp("trial_ends_at"),
  cancelledAt: timestamp("cancelled_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_subscriptions_org").on(table.orgId),
  index("idx_subscriptions_status").on(table.status),
  index("idx_subscriptions_razorpay").on(table.razorpaySubscriptionId),
  unique("uniq_subscriptions_org_id").on(table.orgId, table.id),
]);

export const subscriptionPayments = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id, { onDelete: "cascade" }).notNull(),
  razorpayPaymentId: text("razorpay_payment_id"),
  razorpayOrderId: text("razorpay_order_id"),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  currency: text("currency").default("INR").notNull(),
  status: text("status").notNull(),
  paidAt: timestamp("paid_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_subscription_payments_razorpay_payment").on(table.razorpayPaymentId).where(sql`razorpay_payment_id IS NOT NULL`),
  index("idx_sub_payments_org").on(table.orgId),
  index("idx_sub_payments_sub").on(table.subscriptionId),
  unique("uniq_subscription_payments_org_id").on(table.orgId, table.id),
]);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  organization: one(organizations, { fields: [subscriptions.orgId], references: [organizations.id] }),
  payments: many(subscriptionPayments),
}));

export const subscriptionPaymentsRelations = relations(subscriptionPayments, ({ one }) => ({
  subscription: one(subscriptions, { fields: [subscriptionPayments.subscriptionId], references: [subscriptions.id] }),
}));

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  type: text("type").$type<"PERCENTAGE" | "FIXED">().notNull(),
  value: numeric("value", { precision: 15, scale: 2 }).notNull(),
  minPurchase: numeric("min_purchase", { precision: 15, scale: 2 }),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  applicablePlans: jsonb("applicable_plans").$type<string[]>(),
  expiresAt: timestamp("expires_at"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_coupons_code").on(table.code),
  index("idx_coupons_is_active").on(table.isActive),
  index("idx_coupons_org").on(table.orgId),
]);

export const couponRedemptions = pgTable("coupon_redemptions", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").references(() => coupons.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 15, scale: 2 }),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_coupon_redemptions_coupon_org").on(table.couponId, table.orgId),
  index("idx_coupon_redemptions_coupon").on(table.couponId),
  index("idx_coupon_redemptions_org").on(table.orgId),
  unique("uniq_coupon_redemptions_org_id").on(table.orgId, table.id),
]);

export const couponsRelations = relations(coupons, ({ one, many }) => ({
  organization: one(organizations, { fields: [coupons.orgId], references: [organizations.id] }),
  redemptions: many(couponRedemptions),
}));

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, { fields: [couponRedemptions.couponId], references: [coupons.id] }),
  organization: one(organizations, { fields: [couponRedemptions.orgId], references: [organizations.id] }),
  user: one(users, { fields: [couponRedemptions.userId], references: [users.id] }),
}));

export const aiUsageLogs = pgTable("ai_usage_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
  creditsMilli: integer("credits_milli").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  latencyMs: integer("latency_ms"),
  correlationId: varchar("correlation_id", { length: 64 }),
  outcome: varchar("outcome", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ai_usage_org_feature").on(table.orgId, table.feature),
  index("idx_ai_usage_org_created").on(table.orgId, table.createdAt),
  index("idx_ai_usage_user").on(table.userId),
  unique("uniq_ai_usage_logs_org_id").on(table.orgId, table.id),
]);
