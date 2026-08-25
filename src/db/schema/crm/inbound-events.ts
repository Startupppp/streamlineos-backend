import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * The receipt for one delivery from outside.
 *
 * A provider delivers at least once, and often more than once — a webhook retry,
 * a reconnect that replays a backlog, an operator re-running an import. Without
 * a receipt, the second delivery of a message creates a second party, a second
 * activity and a second follow-up task, and the CRM the PRD is trying to make
 * trustworthy is full of doubles.
 *
 * The unique key is (organisation, provider, provider message id): a message id
 * is unique within a provider, not across tenants, so a global key would let one
 * organisation's delivery suppress another's.
 */
export const inboundEvents = pgTable(
  "inbound_events",
  {
    inboundEventId: text("inbound_event_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    channel: text("channel").notNull(),
    /** Opaque adapter label. Part of the key; nothing branches on it. */
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    providerThreadId: text("provider_thread_id"),

    /**
     * `RECEIVED` while the workflow is in flight, then `PROCESSED` or `FAILED`.
     *
     * A concurrent duplicate is rejected on seeing `RECEIVED` rather than racing
     * the first — two workflows resolving the same unknown sender at the same
     * moment is exactly how a duplicate party gets created.
     */
    status: text("status").default("RECEIVED").notNull(),

    /** The durable run handling it, so a stuck delivery can be traced to its steps. */
    workflowRunId: text("workflow_run_id"),

    /** The normalised event, kept verbatim so a replay needs no provider call. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    /** What it produced, once it has. */
    partyId: text("party_id"),
    activityId: text("activity_id"),

    error: text("error"),
    occurredAt: timestamp("occurred_at").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (t) => [
    unique("uniq_inbound_events_delivery").on(
      t.organizationId,
      t.provider,
      t.providerMessageId,
    ),
    index("idx_inbound_events_org_status").on(t.organizationId, t.status, t.receivedAt),
    index("idx_inbound_events_thread").on(t.organizationId, t.providerThreadId),
  ],
);
