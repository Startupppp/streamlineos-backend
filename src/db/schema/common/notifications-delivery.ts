import { pgTable, pgEnum, text, serial, integer, bigint, boolean, jsonb, timestamp, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
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
import { organizations, users, organizationMembers } from "./auth";
import { broadcasts } from "./broadcasts";
import { notifications } from "./notifications";

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  // SCH-001: was serial (int4) on one of the highest-fan-out tables in the product.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  notificationId: bigint("notification_id", { mode: "number" }),
  notificationCreatedAt: timestamp("notification_created_at", { withTimezone: true }),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  // Stable delivery/audit display projection. membershipId controls recipient access.
  userId: text("user_id").notNull(),
  membershipId: integer("membership_id"),
  eventKey: text("event_key"),
  channel: notificationChannelEnum("channel").notNull(),
  provider: notificationProviderEnum("provider"),
  recipientAddress: text("recipient_address"),
  status: notificationDeliveryStatusEnum("status").default("PENDING").notNull(),
  priority: notificationPriorityEnum("priority").default("NORMAL").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    name: "notification_deliveries_notification_fk",
    columns: [table.notificationId, table.notificationCreatedAt],
    foreignColumns: [notifications.id, notifications.createdAt],
  }).onDelete("cascade"),
  index("idx_notification_deliveries_expiry")
    .on(table.orgId, table.expiresAt)
    .where(sql`expires_at is not null`),
  uniqueIndex("uq_notification_deliveries_idempotency").on(table.idempotencyKey),
  index("idx_notification_deliveries_due").on(table.orgId, table.status, table.nextAttemptAt),
  index("idx_notification_deliveries_notification").on(table.notificationId),
  index("idx_notification_deliveries_membership_channel").on(table.orgId, table.membershipId, table.channel, table.createdAt),
  index("idx_notification_deliveries_org_membership").on(table.orgId, table.membershipId),
  foreignKey({
    name: "fk_notification_deliveries_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
  // SEC-009 retention sweep, which runs per tenant via forEachOrg — a global sweep
  // is denied 42501 by this table's RLS policy.
  index("idx_notification_deliveries_retention").on(table.orgId, table.createdAt),
  index("idx_notification_deliveries_event").on(table.orgId, table.eventKey, table.createdAt),
  unique("uniq_notification_deliveries_org_id").on(table.orgId, table.id),
]);

export const notificationQueue = pgTable("notification_queue", {
  // SCH-001
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  deliveryId: bigint("delivery_id", { mode: "number" }).references(() => notificationDeliveries.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
  status: notificationQueueStatusEnum("status").default("PENDING").notNull(),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_notification_provider_name").on(table.orgId, table.provider, table.displayName),
  index("idx_notification_provider_channel").on(table.orgId, table.channel, table.enabled),
  unique("uniq_notif_provider_accounts_org_id").on(table.orgId, table.id),
]);

export const notificationSuppressionRules = pgTable("notification_suppression_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id"),
  membershipId: integer("membership_id"),
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  channel: notificationChannelEnum("channel"),
  reason: notificationSuppressionReasonEnum("reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => users.id),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_notification_suppression_lookup").on(table.orgId, table.membershipId, table.scopeType, table.scopeKey),
  index("idx_notification_suppression_expiry").on(table.orgId, table.expiresAt),
  unique("uniq_notif_suppression_rules_org_id").on(table.orgId, table.id),
  foreignKey({ name: "fk_notification_suppression_rules_membership", columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id] }).onDelete("cascade"),
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

/**
 * SCH-003. Preferences were four JSONB blobs on `notification_preferences`
 * (`categories`, `channel_categories`, `event_preferences`, `module_preferences`) —
 * unindexable, un-toggleable, and impossible to query ("who has payroll email on").
 *
 * `channel` is NOT NULL with one row per channel rather than a nullable "all" row:
 * a NULL in a unique index enforces nothing, which is the SCH-013 defect. Absence of
 * a rule means "fall through to the header defaults", which is what makes a
 * conservative default expressible at all.
 */
export const notificationPreferenceRules = pgTable(
  "notification_preference_rules",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id").notNull(),
    scopeType: text("scope_type").$type<"EVENT" | "MODULE" | "CATEGORY">().notNull(),
    scopeKey: text("scope_key").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    mode: text("mode").$type<"ON" | "OFF" | "DIGEST">().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_notification_pref_rule").on(t.orgId, t.membershipId, t.scopeType, t.scopeKey, t.channel),
    index("idx_notification_pref_rule_lookup").on(t.orgId, t.membershipId, t.scopeType, t.scopeKey),
    index("idx_notification_pref_rules_org_membership").on(t.orgId, t.membershipId),
    uniqueIndex("uniq_notification_preference_rules_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_notification_pref_rules_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const notificationConsentStateEnum = pgEnum("notification_consent_state", ["GRANTED", "WITHDRAWN"]);
export const notificationConsentSourceEnum = pgEnum("notification_consent_source", ["USER", "ADMIN", "IMPORT", "SIGNUP", "API"]);
export const notificationLegalBasisEnum = pgEnum("notification_legal_basis", ["CONSENT", "CONTRACT", "LEGITIMATE_INTEREST", "LEGAL_OBLIGATION"]);

/**
 * COMP-003. Current consent state per (user, channel, destination). A preference
 * boolean is a setting; this is a record of agreement, with its source, timestamp and
 * legal basis. SMS and WhatsApp cannot legally ship without it.
 */
export const notificationConsents = pgTable(
  "notification_consents",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    destination: text("destination").notNull(),
    state: notificationConsentStateEnum("state").notNull(),
    source: notificationConsentSourceEnum("source").notNull(),
    legalBasis: notificationLegalBasisEnum("legal_basis").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_notification_consents_current").on(t.orgId, t.membershipId, t.channel, t.destination),
    index("idx_notification_consents_org_membership").on(t.orgId, t.membershipId),
    uniqueIndex("uniq_notification_consents_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_notification_consents_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Append-only history. §20 requires consent grants and withdrawals to be logged
 * immutably, which a table carrying a mutable `state` cannot do on its own.
 */
export const notificationConsentEvents = pgTable(
  "notification_consent_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    destination: text("destination").notNull(),
    state: notificationConsentStateEnum("state").notNull(),
    source: notificationConsentSourceEnum("source").notNull(),
    legalBasis: notificationLegalBasisEnum("legal_basis").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_notification_consent_events_subject").on(t.orgId, t.userId, t.channel, t.occurredAt),
    uniqueIndex("uniq_notification_consent_events_org_id").on(t.orgId, t.id),
  ],
);

export const broadcastAudienceKindEnum = pgEnum("broadcast_audience_kind", ["ROLE", "DEPARTMENT", "USER"]);


/**
 * PIPE-008 / PIPE-004. Holds notifications between the event and the send, which is
 * what both digest mode and real coalescing were missing.
 *
 * `coalesce_key` is the aggregation key: repeat events on the same entity collapse
 * onto one row with `occurrence_count`, instead of the first winning and the rest
 * being silently dropped by first-write-wins dedupe.
 */
export const notificationDigestItems = pgTable(
  "notification_digest_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    eventKey: text("event_key").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    link: text("link"),
    coalesceKey: text("coalesce_key").notNull(),
    occurrenceCount: integer("occurrence_count").default(1).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deliverAfter: timestamp("deliver_after", { withTimezone: true }).notNull(),
    flushedAt: timestamp("flushed_at", { withTimezone: true }),
  },
  (t) => [
    // Partial: a flushed row must not block the next window opening its own.
    uniqueIndex("uniq_notification_digest_open")
      .on(t.orgId, t.membershipId, t.channel, t.coalesceKey)
      .where(sql`flushed_at is null`),
    index("idx_notification_digest_due").on(t.orgId, t.deliverAfter).where(sql`flushed_at is null`),
    index("idx_notification_digest_items_org_membership").on(t.orgId, t.membershipId),
    uniqueIndex("uniq_notification_digest_items_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_notification_digest_items_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

/** One row per flushed window, so a retried flush cannot send the same digest twice. */
export const notificationDigestRuns = pgTable(
  "notification_digest_runs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    itemCount: integer("item_count").notNull(),
    deliveryId: bigint("delivery_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_notification_digest_run_window").on(t.orgId, t.userId, t.channel, t.windowEnd),
    uniqueIndex("uniq_notification_digest_runs_org_id").on(t.orgId, t.id),
  ],
);

/**
 * SCH-017. Replaces role/department/user ids buried in `broadcasts.audience` JSONB,
 * which had no referential integrity and needed a GIN containment query to answer
 * "every broadcast targeting department X".
 */
export const broadcastAudienceTargets = pgTable(
  "broadcast_audience_targets",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    broadcastId: integer("broadcast_id").notNull(),
    kind: broadcastAudienceKindEnum("kind").notNull(),
    targetId: text("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_broadcast_audience_target").on(t.broadcastId, t.kind, t.targetId),
    index("idx_broadcast_audience_lookup").on(t.orgId, t.kind, t.targetId),
    uniqueIndex("uniq_broadcast_audience_targets_org_id").on(t.orgId, t.id),
  ],
);

/**
 * c21-02. One row per user who has DISMISSED a broadcast. Unread state is the
 * absence of a row, so publishing writes nothing per recipient and stays O(1)
 * whatever the audience size — a 50,000-member announcement used to be 500
 * sequential inserts inside one transaction, past the HTTP timeout.
 *
 * Every index leads with org_id: under RLS the planner cannot use one that
 * omits it, so a covering index without it exists and does nothing.
 */
export const broadcastReadReceipts = pgTable(
  "broadcast_read_receipts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    broadcastId: integer("broadcast_id").references(() => broadcasts.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_broadcast_read_receipts_org_membership_broadcast").on(t.orgId, t.broadcastId, t.membershipId),
    index("idx_broadcast_read_receipts_admin").on(t.orgId, t.broadcastId),
    index("idx_broadcast_read_receipts_org_membership").on(t.orgId, t.membershipId),
    foreignKey({
      name: "fk_broadcast_read_receipts_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);
