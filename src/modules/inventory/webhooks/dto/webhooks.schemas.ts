import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * What a customer may subscribe to.
 *
 * Additive only. A name that disappears from this list is a webhook somebody
 * registered that silently stops firing, which is the failure this whole module
 * exists to prevent — so the original nine stay exactly as they were spelled,
 * including `po`/`so` rather than the fuller words used below.
 *
 * B3 added the second group. Every one of them already had a *producer* in
 * `INVENTORY_COMMAND_EVENTS` and was routed to `null` in
 * `INVENTORY_WEBHOOK_ROUTES` — "delivered nowhere, deliberately", because giving
 * an event a subscriber-facing name is a contract decision rather than a routing
 * one. This is that decision, taken: a materials business runs on receipts,
 * reservations and transfers between dark stores, and a subscriber that cannot
 * hear any of the three is a subscriber that has to poll.
 */
const WEBHOOK_EVENTS = [
  "inventory.product.created",
  "inventory.stock.changed",
  "inventory.stock.low",
  "inventory.po.created",
  "inventory.po.received",
  "inventory.so.reserved",
  "inventory.so.shipped",
  "inventory.transfer.completed",
  "inventory.adjustment.posted",
  // B3 — names with producers that had nowhere to be delivered.
  /** On-hand reached zero. Distinct from `stock.low`: one is a buying signal, the other is an outage. */
  "inventory.stock.out",
  /** Goods received against a purchase order and posted to a bin. */
  "inventory.stock.received",
  /** Stock held for an order, a project or an internal allocation. */
  "inventory.stock.reserved",
  /** A hold released without being consumed. */
  "inventory.stock.released",
  /** A hold consumed by a dispatch — the promise was kept. */
  "inventory.reservation.fulfilled",
  /** A transfer left its source dark store. The goods are in a van. */
  "inventory.transfer.dispatched",
  /** A pick wave finished; the goods are in totes waiting to be packed. */
  "inventory.picklist.completed",
  /** Customer stock returned and posted back. */
  "inventory.return.received",
  /** Stock quarantined pending a quality decision. */
  "inventory.quality.hold.created",
  /** A quality hold lifted. */
  "inventory.quality.hold.released",
  /** A cycle count posted its variance to the ledger. */
  "inventory.count.posted",
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENTS[number];

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  isActive: z.boolean().optional().default(true),
}).strict();
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
}).strict();
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const listEventsQuerySchema = z.object({
  status: z.enum(["PENDING", "DELIVERED", "FAILED"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();
export type ListEventsQueryInput = z.infer<typeof listEventsQuerySchema>;
