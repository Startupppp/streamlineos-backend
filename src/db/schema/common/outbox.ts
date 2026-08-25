import {
  pgTable,
  pgEnum,
  bigint,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth";

export const outboxDeliveryStateEnum = pgEnum("outbox_delivery_state", [
  "PENDING",
  "IN_FLIGHT",
  "DELIVERED",
  "DEAD",
  "SUPPRESSED",
]);

/**
 * Transactional domain-event outbox (plan §6 outbox/inbox contract). Every aggregate mutation
 * that needs an asynchronous consequence writes its event here in the SAME transaction, so
 * delivery is at-least-once and tenant-scoped. `event_id` is unique (consumer dedup) and
 * `(org, aggregate_type, aggregate_id, aggregate_version)` is unique (monotonic per-aggregate —
 * a stale older version can never be published after a newer one commits).
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    outboxEventId: bigint("outbox_event_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    eventId: text("event_id").notNull(),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    causationId: text("causation_id"),
    correlationId: text("correlation_id"),
    actorMembershipId: text("actor_membership_id"),
    audience: text("audience").notNull().default("INTERNAL"),
    lifecycleState: text("lifecycle_state").notNull().default("ACTIVE"),
    deliveryState: outboxDeliveryStateEnum("delivery_state")
      .notNull()
      .default("PENDING"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    publishedAt: timestamp("published_at"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    deadLetteredAt: timestamp("dead_lettered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_outbox_events_event_id").on(t.eventId),
    uniqueIndex("uniq_outbox_events_org_agg_version").on(
      t.organizationId,
      t.aggregateType,
      t.aggregateId,
      t.aggregateVersion,
    ),
    index("idx_outbox_events_claim").on(
      t.deliveryState,
      t.leaseExpiresAt,
      t.createdAt,
    ),
    index("idx_outbox_events_org_state").on(
      t.organizationId,
      t.deliveryState,
      t.occurredAt,
    ),
  ],
);

/**
 * Consumer-side dedup / inbox. One completion row per (producer event, consumer) provides
 * duplicate suppression for at-least-once delivery; external effects are not made exactly-once
 * by this table alone. A duplicate or stale-version redelivery is safely ignored.
 */
export const inboxRecords = pgTable(
  "inbox_records",
  {
    inboxRecordId: bigint("inbox_record_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    producerEventId: text("producer_event_id").notNull(),
    consumerName: text("consumer_name").notNull(),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    aggregateType: text("aggregate_type"),
    aggregateId: text("aggregate_id"),
    status: text("status").notNull().default("PENDING"),
    processedAt: timestamp("processed_at"),
    lastError: text("last_error"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_inbox_consumer_event").on(
      t.producerEventId,
      t.consumerName,
    ),
    index("idx_inbox_org_status").on(t.organizationId, t.status),
    index("idx_inbox_aggregate_version").on(
      t.organizationId,
      t.consumerName,
      t.aggregateType,
      t.aggregateId,
      t.aggregateVersion,
    ),
  ],
);
