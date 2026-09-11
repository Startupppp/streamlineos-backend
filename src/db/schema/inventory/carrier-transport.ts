import { pgTable, text, serial, integer, timestamp, jsonb, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { invCarriers, invShipments } from "./shipping";

/**
 * INV-26 — what happened when we talked to a courier, and what a courier told
 * us afterwards.
 *
 * Both tables exist for one line of the ticket: *failure states must be
 * visible*. A booking the carrier rejected, a label that never came back, a
 * tracking poll that timed out — each of those is a thing an operator has to be
 * able to see and act on, and none of them changes the shipment. Without a row
 * the only evidence is a log line, and a log line is not a work queue: nobody
 * is watching it at 06:00 when the van is loading.
 *
 * They are kept apart because outbound and inbound fail differently. An
 * outbound call has attempts, a retry ladder and a dead letter; an inbound
 * callback has a signature, a replay and a payload naming something we do not
 * recognise. Collapsing them would give one table two sets of nullable columns
 * and neither meaning would be readable.
 */

/**
 * One call we made to a courier.
 *
 * Append-only. A booking that failed at 06:00 and succeeded at 06:05 is two
 * rows, and that is the record: the first row is why the second one exists, and
 * overwriting it would erase the outage the warehouse actually lived through.
 *
 * `outcome` is the compliance transport's three-way answer rather than a
 * boolean, for its reason: `rejected` is the carrier reading the request and
 * saying no — nothing to retry until something changes — while `unavailable` is
 * the carrier not answering, where the request may be perfectly good. Treating
 * the two alike either retries a rejection forever or abandons a valid shipment
 * on a timeout.
 */
export const invCarrierOperations = pgTable("inv_carrier_operations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  carrierId: integer("carrier_id").notNull(),
  shipmentId: integer("shipment_id").notNull(),
  /** Which adapter made the call, stored so a row says who did the work. */
  transport: text("transport").notNull(),
  /** `book` · `label` · `track`. */
  operation: text("operation").notNull(),
  /** `accepted` · `rejected` · `unavailable`. */
  outcome: text("outcome").notNull(),
  /** Attempts the retry ladder spent. 1 on a first-try success. */
  attempts: integer("attempts").default(1).notNull(),
  /** The carrier's own handle for the consignment, needed to fetch a label. */
  carrierReference: text("carrier_reference"),
  trackingNumber: text("tracking_number"),
  labelUrl: text("label_url"),
  labelFormat: text("label_format"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  /** Null for a scheduled poll, which nobody asked for. */
  requestedBy: text("requested_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_carrier_operations_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_inv_carrier_operations_carrier_id_org",
    columns: [table.orgId, table.carrierId],
    foreignColumns: [invCarriers.orgId, invCarriers.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_inv_carrier_operations_shipment_id_org",
    columns: [table.orgId, table.shipmentId],
    foreignColumns: [invShipments.orgId, invShipments.id],
  }).onDelete("cascade"),
  /** "What has this shipment's carrier done", newest first. */
  index("idx_inv_carrier_operations_org_shipment")
    .on(table.orgId, table.shipmentId, table.createdAt.desc()),
  /**
   * The operator's read: "what is broken right now". Leads with `org_id`
   * because RLS adds `org_id = app.current_org_id()` to every read here and an
   * index that does not supply it can never serve an index-only scan.
   */
  index("idx_inv_carrier_operations_org_outcome")
    .on(table.orgId, table.outcome, table.createdAt.desc()),
]);

/**
 * One callback a courier sent us that verified.
 *
 * A row exists only for a delivery whose signature checked out, so the table
 * cannot be filled by anyone who does not hold the tenant's webhook secret.
 * A failed verification writes `webhookLastFailureAt` on the carrier row
 * instead — visible, and bounded at one row per carrier.
 *
 * `(org_id, carrier_id, event_key)` is the idempotency key and it is a unique
 * index rather than a read-then-write check, because couriers redeliver as a
 * matter of course and two simultaneous deliveries of one event would both pass
 * a check. `ON CONFLICT DO NOTHING` against this index is what makes a replay
 * free: nothing inserted means nothing is applied.
 */
export const invCarrierWebhookDeliveries = pgTable("inv_carrier_webhook_deliveries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  carrierId: integer("carrier_id").notNull(),
  /**
   * The carrier's own event id where it sends one, otherwise the digest of the
   * signed body. The digest is stable, so a genuine redelivery of the same
   * bytes still dedupes; and it is taken from signed material only, never from
   * a header a caller can vary against one captured body.
   */
  eventKey: text("event_key").notNull(),
  /** `applied` · `ignored` · `dead_lettered`. */
  status: text("status").notNull(),
  /** Why it was ignored or dead-lettered, in words an operator can act on. */
  reason: text("reason"),
  trackingNumber: text("tracking_number"),
  /** Null on a dead letter — not knowing which shipment is the dead letter. */
  shipmentId: integer("shipment_id"),
  /** Exactly what the carrier sent. Our reading of it is an interpretation. */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_carrier_webhook_deliveries_org_id").on(table.orgId, table.id),
  unique("uniq_inv_carrier_webhook_deliveries_event")
    .on(table.orgId, table.carrierId, table.eventKey),
  foreignKey({
    name: "fk_inv_carrier_webhook_deliveries_carrier_id_org",
    columns: [table.orgId, table.carrierId],
    foreignColumns: [invCarriers.orgId, invCarriers.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_inv_carrier_webhook_deliveries_shipment_id_org",
    columns: [table.orgId, table.shipmentId],
    foreignColumns: [invShipments.orgId, invShipments.id],
  }).onDelete("cascade"),
  /** The dead-letter queue, which is the whole point of the `status` column. */
  index("idx_inv_carrier_webhook_deliveries_org_status")
    .on(table.orgId, table.status, table.receivedAt.desc()),
]);

export const invCarrierOperationsRelations = relations(invCarrierOperations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invCarrierOperations.orgId],
    references: [organizations.id],
  }),
  carrier: one(invCarriers, {
    fields: [invCarrierOperations.carrierId],
    references: [invCarriers.id],
  }),
  shipment: one(invShipments, {
    fields: [invCarrierOperations.shipmentId],
    references: [invShipments.id],
  }),
}));

export const invCarrierWebhookDeliveriesRelations = relations(
  invCarrierWebhookDeliveries,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [invCarrierWebhookDeliveries.orgId],
      references: [organizations.id],
    }),
    carrier: one(invCarriers, {
      fields: [invCarrierWebhookDeliveries.carrierId],
      references: [invCarriers.id],
    }),
  }),
);
