
import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique, numeric, date } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { notificationTypeEnum, subscriptionStatusEnum, subscriptionPlanEnum } from "./enums";
import { organizations, users } from "./auth";

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").default("INFO").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"),
  isRead: boolean("is_read").default(false).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  channel: text("channel").default("in_app").notNull(),
  sound: boolean("sound").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_notifications_user_unread_created").on(table.userId, table.isRead, table.createdAt),
  index("idx_notifications_org_created").on(table.orgId, table.createdAt),
]);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  orgId: text("org_id").references(() => organizations.id),
  targetId: text("target_id"),
  targetType: text("target_type"),
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
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_push_subs_user").on(table.userId),
]);

export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_calendar_events_org_date").on(table.orgId, table.startDate),
  index("idx_calendar_events_category").on(table.category),
  index("idx_calendar_events_created_by").on(table.createdBy),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull().unique(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  emailEnabled: boolean("email_enabled").default(true).notNull(),
  pushEnabled: boolean("push_enabled").default(true).notNull(),
  smsEnabled: boolean("sms_enabled").default(false).notNull(),
  inAppEnabled: boolean("in_app_enabled").default(true).notNull(),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  categories: jsonb("categories").$type<Record<string, boolean>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

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
]);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
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

export const announcements = pgTable("announcements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  isPinned: boolean("is_pinned").notNull().default(false),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_announcements_org").on(table.orgId, table.expiresAt),
]);

export const announcementsRelations = relations(announcements, ({ one }) => ({
  organization: one(organizations, { fields: [announcements.orgId], references: [organizations.id] }),
  author: one(users, { fields: [announcements.authorId], references: [users.id] }),
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
  index("idx_sub_payments_org").on(table.orgId),
  index("idx_sub_payments_sub").on(table.subscriptionId),
]);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  organization: one(organizations, { fields: [subscriptions.orgId], references: [organizations.id] }),
  payments: many(subscriptionPayments),
}));

export const subscriptionPaymentsRelations = relations(subscriptionPayments, ({ one }) => ({
  subscription: one(subscriptions, { fields: [subscriptionPayments.subscriptionId], references: [subscriptions.id] }),
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
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ai_usage_org_feature").on(table.orgId, table.feature),
  index("idx_ai_usage_org_created").on(table.orgId, table.createdAt),
  index("idx_ai_usage_user").on(table.userId),
]);

export type CalendarProvider = "GOOGLE" | "MICROSOFT";

export const userCalendarConnections = pgTable("user_calendar_connections", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").$type<CalendarProvider>().notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),
  providerEmail: text("provider_email"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_calendar_connections_user_account")
    .on(table.userId, table.provider, table.providerEmail)
    .nullsNotDistinct(),
  index("idx_calendar_connections_user").on(table.userId),
]);

export const userCalendarConnectionsRelations = relations(userCalendarConnections, ({ one }) => ({
  user: one(users, { fields: [userCalendarConnections.userId], references: [users.id] }),
}));

export type CouponType = "PERCENTAGE" | "FIXED";

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  type: text("type").$type<CouponType>().notNull(),
  value: numeric("value", { precision: 10, scale: 2 }).notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").default(0).notNull(),
  applicablePlans: text("applicable_plans").array(),
  expiresAt: timestamp("expires_at"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_coupons_code").on(table.code),
  index("idx_coupons_code").on(table.code),
  index("idx_coupons_active").on(table.isActive),
]);

export const couponRedemptions = pgTable("coupon_redemptions", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").references(() => coupons.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_coupon_redemptions_org_coupon").on(table.couponId, table.orgId),
  index("idx_coupon_redemptions_coupon").on(table.couponId),
  index("idx_coupon_redemptions_org").on(table.orgId),
]);

export const couponsRelations = relations(coupons, ({ many }) => ({
  redemptions: many(couponRedemptions),
}));

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, { fields: [couponRedemptions.couponId], references: [coupons.id] }),
  org: one(organizations, { fields: [couponRedemptions.orgId], references: [organizations.id] }),
}));

export type Coupon = typeof coupons.$inferSelect;
export type CouponRedemption = typeof couponRedemptions.$inferSelect;
