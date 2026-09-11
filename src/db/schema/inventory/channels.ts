import { pgTable, text, serial, timestamp, decimal, integer, jsonb, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  invChannelTypeEnum,
  invChannelStatusEnum,
  invChannelPubStatusEnum,
  inv3plStatusEnum,
  invChannelDeliveryStatusEnum,
  invChannelSnapshotDiffStatusEnum,
  invChannelSnapshotPolicyEnum,
  invQcProviderEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invLocations } from "./warehouses";
import { invStockTransactions } from "./stock";

export const invChannels = pgTable("inv_channels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  channelType: invChannelTypeEnum("channel_type").notNull(),
  status: invChannelStatusEnum("status").default("ACTIVE").notNull(),
  safetyBuffer: decimal("safety_buffer", { precision: 18, scale: 4 }).default("0"),
  publishThreshold: decimal("publish_threshold", { precision: 18, scale: 4 }),
  warehouseIds: jsonb("warehouse_ids").$type<number[]>().default([]),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
  /**
   * E6 — what this organisation has decided may happen when the channel's stock
   * figure disagrees with ours. Defaults to the answer that touches nothing.
   */
  snapshotPolicy: invChannelSnapshotPolicyEnum("snapshot_policy").default("RECORD_DIFFERENCE").notNull(),
  /**
   * Where an accepted difference posts.
   *
   * Nullable, and `ALLOW_ADJUSTMENT` without it refuses rather than guessing: a
   * channel names *warehouses*, and a warehouse is not a place stock can sit.
   * Picking one of its locations on the caller's behalf would put a correction
   * somewhere nobody chose.
   */
  reconciliationLocationId: integer("reconciliation_location_id"),
  /**
   * NEO-2 — which quick-commerce network this channel *is*, when it is one.
   *
   * It is what ties an ingested Blinkit purchase order to a Streamline channel,
   * and therefore to that channel's reserved pool (NEO-1): accepting the PO
   * claims the stock for Blinkit, so the same units stop being offered on the
   * storefront. Null for every ordinary channel, which is most of them.
   */
  qcProvider: invQcProviderEnum("qc_provider"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_channels_org_name").on(table.orgId, table.name),
  unique("uniq_inv_channels_org_id").on(table.orgId, table.id),
  index("idx_inv_channels_org_status").on(table.orgId, table.status),
  // One channel per provider per organisation: two Blinkit channels would make
  // "which pool does this PO claim into" a question with two answers.
  uniqueIndex("uniq_inv_channels_org_qc_provider")
    .on(table.orgId, table.qcProvider)
    .where(sql`qc_provider IS NOT NULL`),
  foreignKey({
    columns: [table.orgId, table.reconciliationLocationId],
    foreignColumns: [invLocations.orgId, invLocations.id],
    name: "fk_inv_channels_reconciliation_location_org",
  }),
]);

export const invChannelStockPublications = pgTable("inv_channel_stock_publications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  publishedQty: decimal("published_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  availableQty: decimal("available_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  status: invChannelPubStatusEnum("status").default("PENDING").notNull(),
  error: text("error"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_pub_org_channel_variant").on(table.orgId, table.channelId, table.productVariantId),
  unique("uniq_inv_channel_stock_publications_org_id").on(table.orgId, table.id),
  index("idx_inv_pub_status").on(table.orgId, table.status),
]);

export const inv3plConnections = pgTable("inv_3pl_connections", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  status: inv3plStatusEnum("status").default("DISCONNECTED").notNull(),
  externalWarehouseRef: text("external_warehouse_ref"),
  skuMapping: jsonb("sku_mapping").$type<Record<string, string>>(),
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncStatus: text("last_sync_status"),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_3pl_connections_org_id").on(table.orgId, table.id),
  index("idx_inv_3pl_org_status").on(table.orgId, table.status),
]);

/**
 * E6 — what a sales channel posted at us, and the fence that makes a duplicate
 * delivery a no-op.
 *
 * The raw body is deliberately **not** kept. A marketplace payload carries a
 * customer's name and address, and this table exists to answer "have we already
 * handled delivery X", not to become a second copy of somebody's order book.
 * `payloadDigest` is enough to show that two deliveries carrying the same id
 * really were the same bytes.
 *
 * The row is also the queue: the receiver verifies, inserts and acknowledges,
 * and `ChannelSnapshotWorker` drains `PENDING` outside any request. That is
 * what "ack fast, enqueue refetch" means here — the durable row *is* the
 * enqueue, so a delivery that arrives while the drain is down is not lost, and
 * no HTTP call to a marketplace ever runs inside a tenant transaction
 * (backend/CLAUDE.md §4).
 */
export const invChannelWebhookDeliveries = pgTable("inv_channel_webhook_deliveries", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "cascade" }).notNull(),
  /** The channel's own delivery id — `X-Shopify-Webhook-Id`, `X-WC-Webhook-Delivery-ID`. */
  providerDeliveryId: text("provider_delivery_id").notNull(),
  topic: text("topic").notNull(),
  /** The channel's identifier for the thing that changed, when its payload names one. */
  externalRef: text("external_ref"),
  status: invChannelDeliveryStatusEnum("status").default("PENDING").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  /** Non-secret delivery headers, for an operator reconstructing what arrived. */
  deliveryMetadata: jsonb("delivery_metadata").$type<Record<string, string>>(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lastError: text("last_error"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_channel_webhook_deliveries_org_id").on(table.orgId, table.id),
  // E6's done-when, as a constraint rather than a convention.
  unique("uniq_inv_channel_delivery").on(table.orgId, table.channelId, table.providerDeliveryId),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_channel_deliveries_channel_org",
  }),
  index("idx_inv_channel_deliveries_org_status").on(table.orgId, table.status, table.receivedAt),
]);

/**
 * E6 — the channel and the ledger disagree, written down.
 *
 * Not a ledger and not a movement. `stockTransactionId` is null until a named
 * operator accepts the difference, at which point it names the ordinary
 * stock-engine movement that resolved it — which is the whole of E6's "snapshot
 * cannot drive `quantity_change` by itself", visible in the shape of the row.
 *
 * `productVariantId` is nullable on purpose: a channel SKU matching nothing of
 * ours is the most common real finding, and dropping those rows would turn the
 * most useful signal this table produces into silence. `externalSku` is the
 * identity; the variant is the resolution.
 */
export const invChannelSnapshotDiffs = pgTable("inv_channel_snapshot_diffs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "cascade" }).notNull(),
  /** The delivery that triggered the refetch. Null for a scheduled sweep. */
  deliveryId: integer("delivery_id"),
  productVariantId: integer("product_variant_id"),
  externalSku: text("external_sku").notNull(),
  channelQty: decimal("channel_qty", { precision: 18, scale: 4 }).notNull(),
  internalQty: decimal("internal_qty", { precision: 18, scale: 4 }).notNull(),
  difference: decimal("difference", { precision: 18, scale: 4 }).notNull(),
  status: invChannelSnapshotDiffStatusEnum("status").default("OPEN").notNull(),
  snapshotAt: timestamp("snapshot_at").notNull(),
  resolvedBy: text("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  resolutionNote: text("resolution_note"),
  stockTransactionId: integer("stock_transaction_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_channel_snapshot_diffs_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_channel_diffs_channel_org",
  }),
  // MATCH SIMPLE, so an unmatched channel SKU — the null variant — passes the
  // composite pair rather than needing an exemption. Same for a diff from a
  // scheduled refetch, which names no delivery, and one nobody has accepted,
  // which names no movement.
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_channel_diffs_variant_org",
  }),
  foreignKey({
    columns: [table.orgId, table.deliveryId],
    foreignColumns: [invChannelWebhookDeliveries.orgId, invChannelWebhookDeliveries.id],
    name: "fk_inv_channel_diffs_delivery_org",
  }),
  foreignKey({
    columns: [table.orgId, table.stockTransactionId],
    foreignColumns: [invStockTransactions.orgId, invStockTransactions.id],
    name: "fk_inv_channel_diffs_txn_org",
  }),
  // One OPEN difference per channel SKU, so a refetch that finds the same
  // disagreement updates it rather than adding to a pile.
  uniqueIndex("uniq_inv_channel_snapshot_diff_open")
    .on(table.orgId, table.channelId, table.externalSku)
    .where(sql`status = 'OPEN'`),
  index("idx_inv_channel_diffs_org_channel_status")
    .on(table.orgId, table.channelId, table.status, table.snapshotAt),
  check(
    "chk_inv_channel_diffs_difference",
    sql`${table.difference} = ${table.channelQty} - ${table.internalQty}`,
  ),
  check(
    "chk_inv_channel_diffs_resolution",
    sql`${table.status} = 'OPEN' OR (${table.resolvedBy} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
  ),
]);

export const invChannelWebhookDeliveriesRelations = relations(invChannelWebhookDeliveries, ({ one }) => ({
  organization: one(organizations, { fields: [invChannelWebhookDeliveries.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invChannelWebhookDeliveries.channelId], references: [invChannels.id] }),
}));

export const invChannelSnapshotDiffsRelations = relations(invChannelSnapshotDiffs, ({ one }) => ({
  organization: one(organizations, { fields: [invChannelSnapshotDiffs.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invChannelSnapshotDiffs.channelId], references: [invChannels.id] }),
  productVariant: one(invProductVariants, { fields: [invChannelSnapshotDiffs.productVariantId], references: [invProductVariants.id] }),
}));

export const invChannelsRelations = relations(invChannels, ({ one, many }) => ({
  organization: one(organizations, { fields: [invChannels.orgId], references: [organizations.id] }),
  publications: many(invChannelStockPublications),
}));

export const invChannelStockPublicationsRelations = relations(invChannelStockPublications, ({ one }) => ({
  organization: one(organizations, { fields: [invChannelStockPublications.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invChannelStockPublications.channelId], references: [invChannels.id] }),
  productVariant: one(invProductVariants, { fields: [invChannelStockPublications.productVariantId], references: [invProductVariants.id] }),
}));

export const inv3plConnectionsRelations = relations(inv3plConnections, ({ one }) => ({
  organization: one(organizations, { fields: [inv3plConnections.orgId], references: [organizations.id] }),
}));
