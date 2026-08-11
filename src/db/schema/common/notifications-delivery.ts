import { pgTable, text, serial, integer, bigint, boolean, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  notificationTypeEnum,
  notificationPriorityEnum,
  notificationChannelEnum,
  notificationDeliveryStatusEnum,
  notificationQueueStatusEnum,
  notificationPolicyScopeEnum,
  notificationProviderEnum,
  notificationQuietHoursBehaviorEnum,
  notificationSuppressionReasonEnum,
} from "./enums";
import { organizations, users } from "./auth";
import { notifications } from "./shared";

export const notificationEvents = pgTable("notification_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  sourceModule: text("source_module").notNull(),
  category: text("category").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  defaultPriority: notificationPriorityEnum("default_priority").default("NORMAL").notNull(),
  defaultType: notificationTypeEnum("default_type").default("INFO").notNull(),
  defaultChannels: jsonb("default_channels").$type<string[]>().default(["IN_APP"]).notNull(),
  allowedChannels: jsonb("allowed_channels").$type<string[]>().default(["IN_APP"]).notNull(),
  mandatory: boolean("mandatory").default(false).notNull(),
  userConfigurable: boolean("user_configurable").default(true).notNull(),
  adminConfigurable: boolean("admin_configurable").default(true).notNull(),
  quietHoursBehavior: notificationQuietHoursBehaviorEnum("quiet_hours_behavior").default("respect").notNull(),
  dedupeWindowSeconds: integer("dedupe_window_seconds").default(0).notNull(),
  rateLimitWindowSeconds: integer("rate_limit_window_seconds").default(0).notNull(),
  rateLimitMax: integer("rate_limit_max").default(0).notNull(),
  templateKey: text("template_key"),
  audienceResolver: text("audience_resolver"),
  visibilityResourceKind: text("visibility_resource_kind"),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_notification_events_org_key").on(table.orgId, table.eventKey),
  // SCH-013: the composite above enforces nothing for the catalog, because every
  // catalog row has org_id IS NULL and NULL <> NULL in a btree unique. This partial
  // index covers exactly the global rows.
  uniqueIndex("uniq_notification_events_global_key").on(table.eventKey).where(sql`org_id is null`),
  index("idx_notification_events_module").on(table.sourceModule),
  index("idx_notification_events_category").on(table.category),
  unique("uniq_notification_events_org_id").on(table.orgId, table.id),
]);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: serial("id").primaryKey(),
  notificationId: integer("notification_id").references(() => notifications.id, { onDelete: "cascade" }),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  eventKey: text("event_key"),
  channel: notificationChannelEnum("channel").notNull(),
  provider: notificationProviderEnum("provider"),
  recipientAddress: text("recipient_address"),
  status: notificationDeliveryStatusEnum("status").default("PENDING").notNull(),
  priority: notificationPriorityEnum("priority").default("NORMAL").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  nextAttemptAt: timestamp("next_attempt_at"),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  readAt: timestamp("read_at"),
  clickedAt: timestamp("clicked_at"),
  failedAt: timestamp("failed_at"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  suppressionReason: notificationSuppressionReasonEnum("suppression_reason"),
  providerMessageId: text("provider_message_id"),
  providerResponse: jsonb("provider_response").$type<Record<string, unknown>>(),
  costAmount: integer("cost_amount").default(0).notNull(),
  costCurrency: text("cost_currency").default("USD").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  // REG-008: what was actually sent, so a later template edit cannot rewrite history.
  renderedSubject: text("rendered_subject"),
  renderedBody: text("rendered_body"),
  templateVersion: integer("template_version"),
  // PIPE-012: past this the notification is dropped rather than delivered stale.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_notification_deliveries_expiry")
    .on(table.orgId, table.expiresAt)
    .where(sql`expires_at is not null`),
  uniqueIndex("uq_notification_deliveries_idempotency").on(table.idempotencyKey),
  index("idx_notification_deliveries_due").on(table.orgId, table.status, table.nextAttemptAt),
  index("idx_notification_deliveries_notification").on(table.notificationId),
  index("idx_notification_deliveries_user_channel").on(table.orgId, table.userId, table.channel, table.createdAt),
  // SEC-009 retention sweep, which runs per tenant via forEachOrg — a global sweep
  // is denied 42501 by this table's RLS policy.
  index("idx_notification_deliveries_retention").on(table.orgId, table.createdAt),
  index("idx_notification_deliveries_event").on(table.orgId, table.eventKey, table.createdAt),
  unique("uniq_notification_deliveries_org_id").on(table.orgId, table.id),
]);

export const notificationQueue = pgTable("notification_queue", {
  id: serial("id").primaryKey(),
  deliveryId: integer("delivery_id").references(() => notificationDeliveries.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  status: notificationQueueStatusEnum("status").default("PENDING").notNull(),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at"),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_notification_queue_due").on(table.status, table.runAt),
  index("idx_notification_queue_delivery").on(table.deliveryId),
  // SCH-015: one queue job per delivery. The worker already updates rather than
  // re-inserting; this makes that the database's invariant, not the caller's.
  uniqueIndex("uniq_notification_queue_delivery").on(table.deliveryId),
  index("idx_notification_queue_org").on(table.orgId),
  unique("uniq_notification_queue_org_id").on(table.orgId, table.id),
]);

export const notificationPolicyDefaults = pgTable("notification_policy_defaults", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  scopeType: notificationPolicyScopeEnum("scope_type").notNull(),
  scopeId: text("scope_id"),
  defaultChannels: jsonb("default_channels").$type<string[]>().default([]).notNull(),
  eventOverrides: jsonb("event_overrides").$type<Record<string, { channels?: string[]; muted?: boolean }>>().default({}).notNull(),
  categoryOverrides: jsonb("category_overrides").$type<Record<string, { channels?: string[]; muted?: boolean }>>().default({}).notNull(),
  moduleOverrides: jsonb("module_overrides").$type<Record<string, { channels?: string[]; muted?: boolean }>>().default({}).notNull(),
  canUserOverride: boolean("can_user_override").default(true).notNull(),
  resolutionOrder: integer("resolution_order").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_notification_policy_scope").on(table.orgId, table.scopeType, table.scopeId),
  index("idx_notification_policy_org_scope").on(table.orgId, table.scopeType),
  unique("uniq_notif_policy_defaults_org_id").on(table.orgId, table.id),
]);

export const notificationProviderAccounts = pgTable("notification_provider_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  provider: notificationProviderEnum("provider").notNull(),
  displayName: text("display_name").notNull(),
  configEncrypted: text("config_encrypted"),
  enabled: boolean("enabled").default(true).notNull(),
  sandboxMode: boolean("sandbox_mode").default(true).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  dailySendLimit: integer("daily_send_limit"),
  monthlyCostLimit: integer("monthly_cost_limit"),
  healthStatus: text("health_status").default("unknown").notNull(),
  lastTestedAt: timestamp("last_tested_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_notification_provider_name").on(table.orgId, table.provider, table.displayName),
  index("idx_notification_provider_channel").on(table.orgId, table.channel, table.enabled),
  unique("uniq_notif_provider_accounts_org_id").on(table.orgId, table.id),
]);

export const notificationSuppressionRules = pgTable("notification_suppression_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  channel: notificationChannelEnum("channel"),
  reason: notificationSuppressionReasonEnum("reason").notNull(),
  expiresAt: timestamp("expires_at"),
  createdBy: text("created_by").references(() => users.id),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_notification_suppression_lookup").on(table.orgId, table.userId, table.scopeType, table.scopeKey),
  index("idx_notification_suppression_expiry").on(table.orgId, table.expiresAt),
  unique("uniq_notif_suppression_rules_org_id").on(table.orgId, table.id),
]);

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  notification: one(notifications, {
    fields: [notificationDeliveries.notificationId],
    references: [notifications.id],
  }),
  queueJob: one(notificationQueue, {
    fields: [notificationDeliveries.id],
    references: [notificationQueue.deliveryId],
  }),
}));

export const notificationQueueRelations = relations(notificationQueue, ({ one }) => ({
  delivery: one(notificationDeliveries, {
    fields: [notificationQueue.deliveryId],
    references: [notificationDeliveries.id],
  }),
}));

/**
 * PIPE-001. Durable delivery intent, written inside the caller's transaction so the
 * domain change and the intent to notify commit together or not at all.
 * `registerAfterCommit` is an in-memory hook: a crash between COMMIT and the hook
 * draining loses the notification with no record it was owed.
 *
 * `targetUserIds` / `variables` / `metadata` are jsonb deliberately — an immutable
 * copy of the call's arguments, never queried, joined or updated. The relational
 * state is `notification_deliveries`, written per recipient per channel by the relay.
 */
export const notificationOutbox = pgTable("notification_outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  eventKey: text("event_key").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  actorUserId: text("actor_user_id"),
  notifySelf: boolean("notify_self").default(false).notNull(),
  targetUserIds: jsonb("target_user_ids").$type<string[]>().notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  title: text("title"),
  message: text("message"),
  link: text("link"),
  variables: jsonb("variables").$type<Record<string, unknown>>().default({}).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  state: text("state").$type<"PENDING" | "IN_FLIGHT" | "PROCESSED" | "DEAD">().default("PENDING").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("uniq_notification_outbox_org_id").on(table.orgId, table.id),
  // A retried request must not enqueue the same intent twice.
  uniqueIndex("uniq_notification_outbox_dedupe").on(table.orgId, table.dedupeKey),
  index("idx_notification_outbox_claim")
    .on(table.state, table.leaseExpiresAt, table.id)
    .where(sql`state in ('PENDING','IN_FLIGHT')`),
]);
