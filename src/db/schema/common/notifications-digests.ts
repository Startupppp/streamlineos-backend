/**
 * Notifications that are held back, and broadcasts that are aimed.
 *
 * A digest is the opposite of the delivery engine's default: an item is parked
 * rather than sent, and a run is the batch that later sends the collected items
 * as one message. Broadcast audience targets and read receipts are here for the
 * same reason — they are about choosing and measuring a set of recipients, not
 * about the mechanics of reaching one.
 *
 * Split out of `notifications-delivery.ts`.
 */

import { pgTable, pgEnum, text, integer, bigint, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { notificationChannelEnum } from "./enums";
import { organizations, users, organizationMembers } from "./auth";
import { broadcasts } from "./broadcasts";

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
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id"),
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
      .on(t.orgId, t.userId, t.channel, t.coalesceKey)
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
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    membershipId: integer("membership_id"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_broadcast_read_receipts_org_user_broadcast").on(t.orgId, t.broadcastId, t.userId),
    index("idx_broadcast_read_receipts_admin").on(t.orgId, t.broadcastId),
    index("idx_broadcast_read_receipts_user").on(t.orgId, t.userId),
    index("idx_broadcast_read_receipts_org_membership").on(t.orgId, t.membershipId),
    foreignKey({
      name: "fk_broadcast_read_receipts_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);
