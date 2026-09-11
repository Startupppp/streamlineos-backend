/**
 * What a recipient has asked for, and what the law lets us send anyway.
 *
 * Three layers that the engine resolves in order and that are deliberately
 * separate rows rather than one settings blob: the organisation's defaults, the
 * person's own per-event per-channel rules, and the suppression rules that
 * override both. Beside them sits consent — its current state per channel and
 * the append-only event log of every grant and withdrawal, which is the half a
 * regulator asks for and the half a current-state column cannot answer.
 *
 * Split out of `notifications-delivery.ts`: none of this decides how a message
 * is sent, only whether it may be.
 */

import { pgTable, pgEnum, text, serial, integer, bigint, boolean, jsonb, timestamp, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { notificationChannelEnum, notificationPolicyScopeEnum, notificationSuppressionReasonEnum } from "./enums";
import { organizations, users, organizationMembers } from "./auth";

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

export const notificationSuppressionRules = pgTable("notification_suppression_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  channel: notificationChannelEnum("channel"),
  reason: notificationSuppressionReasonEnum("reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => users.id),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_notification_suppression_lookup").on(table.orgId, table.userId, table.scopeType, table.scopeKey),
  index("idx_notification_suppression_expiry").on(table.orgId, table.expiresAt),
  unique("uniq_notif_suppression_rules_org_id").on(table.orgId, table.id),
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
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id"),
    scopeType: text("scope_type").$type<"EVENT" | "MODULE" | "CATEGORY">().notNull(),
    scopeKey: text("scope_key").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    mode: text("mode").$type<"ON" | "OFF" | "DIGEST">().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_notification_pref_rule").on(t.orgId, t.userId, t.scopeType, t.scopeKey, t.channel),
    index("idx_notification_pref_rule_lookup").on(t.orgId, t.userId, t.scopeType, t.scopeKey),
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
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id"),
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
    uniqueIndex("uniq_notification_consents_current").on(t.orgId, t.userId, t.channel, t.destination),
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
