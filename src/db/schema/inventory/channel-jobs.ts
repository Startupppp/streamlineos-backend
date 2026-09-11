import { pgTable, text, timestamp, integer, jsonb, index, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invChannelDeliveryStatusEnum, invChannelJobKindEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invChannels } from "./channels";
import { invSalesOrders } from "./sales-orders";

/**
 * INV-27 — the work an organisation has asked a channel adapter to do, and the
 * dead-letter box that work falls into when it fails.
 *
 * ## Why this lives in its own file
 *
 * It keys into both `inv_channels` and `inv_sales_orders`, and
 * `sales-orders.ts` already imports `channels.ts`. Declaring it in either of
 * those would make the pair circular, and a Drizzle table's config callback runs
 * eagerly — the composite key's `foreignColumns` would resolve to `undefined`
 * and the declaration would silently lose the constraint. `quick-commerce.ts`
 * hit the same wall from the other side and answered it by leaving
 * `inv_sales_orders.platform_po_id` a bare column; a third file is the answer
 * that keeps the key.
 *
 * ## Why this is not `inv_channel_webhook_deliveries`
 *
 * That table is "what a sales channel posted at us": its `received_at`, its
 * `payload_digest` and its `provider_delivery_id` are all facts about an inbound
 * request we did not initiate. These rows are the other direction — work *we*
 * decided to do — and folding them in would have made the drain worker branch on
 * `topic` to decide whether a row meant "refetch a snapshot" or "push
 * availability", with three of that table's columns holding something other than
 * what their comments say. Two queues, one attempt ladder
 * (`planChannelAttempt`), one status vocabulary (`inv_channel_delivery_status`),
 * and one operator surface that lists both.
 *
 * ## The natural key is the idempotency
 *
 * `(org_id, channel_id, kind, external_ref)` is unique, and for an
 * `ORDER_IMPORT` the `external_ref` is the channel's own order id. That is what
 * makes re-importing the same order a no-op in the database rather than in the
 * worker's memory, where a crash between "fetched" and "created" loses it. The
 * refs are namespaced by `kind`, so order `1001` and the shipment for order
 * `1001` are two rows rather than a collision.
 *
 * ## Why the payloads are small
 *
 * `request` and `response` hold what an operator needs to understand a failure —
 * the SKUs and quantities offered, the identifier the channel returned — never
 * the marketplace's payload whole. A channel order carries a customer's name and
 * address, and a retry queue is a bad place for a second copy of somebody's
 * order book. Same reason `inv_channel_webhook_deliveries` keeps a digest rather
 * than a body.
 */
export const invChannelJobs = pgTable("inv_channel_jobs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "cascade" }).notNull(),
  kind: invChannelJobKindEnum("kind").notNull(),
  /** The channel's own handle for this unit of work — an order id, a run id. */
  externalRef: text("external_ref").notNull(),
  status: invChannelDeliveryStatusEnum("status").default("PENDING").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  /**
   * The adapter's code for the last failure (`HTTP_503`, `NO_CREDENTIAL`), kept
   * beside the message so a screen can group a hundred dead letters by cause
   * without parsing prose.
   */
  lastErrorCode: text("last_error_code"),
  lastError: text("last_error"),
  /** What we asked the channel to do. Small by design — see the note above. */
  request: jsonb("request").$type<Record<string, unknown>>(),
  /** What the channel answered, success or refusal. Ship confirm's whole point. */
  response: jsonb("response").$type<Record<string, unknown>>(),
  /** What an ORDER_IMPORT produced. Null until it produced one. */
  salesOrderId: integer("sales_order_id"),
  /**
   * When the ladder says this may be tried again. A retry is "set this to now",
   * which is why it is a timestamp rather than a flag.
   */
  nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
  leaseExpiresAt: timestamp("lease_expires_at"),
  processedAt: timestamp("processed_at"),
  deadLetteredAt: timestamp("dead_lettered_at"),
  /**
   * The operator who asked for this.
   *
   * A channel job creates real records — a sales order, a fulfilment a customer
   * is told about — and a background sweep has no actor of its own, so the actor
   * is recorded when the work is asked for and the drain writes under it.
   * `inv_sales_orders.created_by` is NOT NULL, and "whoever the drain happened
   * to be" is not an answer to who raised an order.
   */
  enqueuedBy: text("enqueued_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_channel_jobs_org_id").on(table.orgId, table.id),
  // The natural key. See the header: this is order-import idempotency as a
  // constraint, rather than as a convention the worker is trusted to keep.
  unique("uniq_inv_channel_job_ref").on(table.orgId, table.channelId, table.kind, table.externalRef),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_channel_jobs_channel_org",
  }),
  // MATCH SIMPLE, so a job that has not produced an order — which is every job
  // that is not a completed import — passes the pair without an exemption.
  foreignKey({
    columns: [table.orgId, table.salesOrderId],
    foreignColumns: [invSalesOrders.orgId, invSalesOrders.id],
    name: "fk_inv_channel_jobs_sales_order_org",
  }),
  // The claim: due work, oldest first. Two equalities then the inequality that
  // is also the sort, which is the order §3 asks for.
  index("idx_inv_channel_jobs_due").on(table.orgId, table.status, table.nextAttemptAt),
  // "What is wrong with this channel" — the read behind the dead-letter screen.
  index("idx_inv_channel_jobs_org_channel_status")
    .on(table.orgId, table.channelId, table.status, table.createdAt),
  // A dead letter with no reason is the exact failure this row exists to
  // prevent, so the database refuses one rather than the worker remembering.
  check(
    "chk_inv_channel_jobs_dead_has_reason",
    sql`${table.status} <> 'DEAD' OR (${table.lastError} IS NOT NULL AND ${table.deadLetteredAt} IS NOT NULL)`,
  ),
]);

export const invChannelJobsRelations = relations(invChannelJobs, ({ one }) => ({
  organization: one(organizations, { fields: [invChannelJobs.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invChannelJobs.channelId], references: [invChannels.id] }),
  salesOrder: one(invSalesOrders, { fields: [invChannelJobs.salesOrderId], references: [invSalesOrders.id] }),
}));
