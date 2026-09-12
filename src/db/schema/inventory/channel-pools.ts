import { pgTable, text, serial, timestamp, decimal, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../common/auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";
import { invChannels } from "./channels";

/**
 * NEO-1 — a channel's claim on stock it has not shipped yet.
 *
 * A brand selling on Blinkit and on its own storefront holds one pile of stock
 * and two promises about it. Without this table both promises are made against
 * the same `availableQty`, and the first order on either side sells units the
 * other has already committed. That is the whole of the q-commerce hole: the
 * ledger is not wrong, it is simply asked one question when there are two.
 *
 * `reserved_qty` is the claim: units withheld from every *other* channel's ATP,
 * including the direct one. `published_qty` is the number the channel was last
 * told — a record of what we said, never an input to what is true. E6 already
 * fixed the direction of that arrow for snapshots and this keeps it: a marketplace
 * telling us a figure updates `published_qty` and nothing else.
 *
 * **Grain.** `(channel, warehouse?, variant)`. `warehouse_id` is nullable and the
 * two cases mean different things, deliberately:
 *
 *   * **pinned** (`warehouse_id` set) — the claim is on that warehouse's stock.
 *     A dark store serving one metro reserves against the depot that feeds it.
 *   * **unpinned** (`NULL`) — an organisation-wide claim on the variant.
 *
 * An unpinned claim is subtracted from *every* warehouse-scoped ATP as well as
 * from the org-wide roll-up. That over-subtracts when several warehouses hold
 * the variant, and it does so on purpose: this table exists to stop a double
 * sale, and refusing an order we could have filled is recoverable in a way that
 * shipping stock twice is not. Pin the pool to a warehouse to get the exact
 * figure. `ChannelPoolService.availability` is the only place that rule is
 * written down.
 *
 * There is no ledger row here and there must never be one. A pool is a claim on
 * stock, not a movement of it: nothing in this table changes `on_hand`, and
 * `StockEngineService` remains the only writer of `inv_stock_levels` and
 * `inv_stock_transactions`. Fulfilling a channel order still posts through the
 * engine like any other issue; all this does is decide who may be promised what.
 */
export const invChannelPools = pgTable("inv_channel_pools", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  channelId: integer("channel_id").references(() => invChannels.id, { onDelete: "cascade" }).notNull(),
  /** Null means the claim is organisation-wide. See the grain note above. */
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "cascade" }).notNull(),
  reservedQty: decimal("reserved_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  publishedQty: decimal("published_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  // `coalesce` rather than a plain unique tuple: Postgres treats NULLs as
  // distinct, so an unpinned pool could otherwise be created twice for the same
  // channel and variant and each half would look correct on its own.
  uniqueIndex("uniq_inv_channel_pools_grain")
    .on(table.orgId, table.channelId, table.productVariantId, sql`coalesce(${table.warehouseId}, 0)`),
  unique("uniq_inv_channel_pools_org_id").on(table.orgId, table.id),
  // The ATP probe: "what do all channels claim on this variant here". Leads with
  // `org_id` so it survives RLS (backend/CLAUDE.md §7).
  index("idx_inv_channel_pools_org_variant_warehouse")
    .on(table.orgId, table.productVariantId, table.warehouseId),
  index("idx_inv_channel_pools_org_channel").on(table.orgId, table.channelId),
  foreignKey({
    columns: [table.orgId, table.channelId],
    foreignColumns: [invChannels.orgId, invChannels.id],
    name: "fk_inv_channel_pools_channel_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_channel_pools_warehouse_org",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_channel_pools_variant_org",
  }).onDelete("cascade"),
  // A negative claim is not a claim, and a release that over-releases would
  // otherwise read as one. The service clamps; this makes it true against a
  // direct write.
  check("chk_inv_channel_pools_reserved_nonneg", sql`${table.reservedQty} >= 0`),
  check("chk_inv_channel_pools_published_nonneg", sql`${table.publishedQty} >= 0`),
]);

export const invChannelPoolsRelations = relations(invChannelPools, ({ one }) => ({
  organization: one(organizations, { fields: [invChannelPools.orgId], references: [organizations.id] }),
  channel: one(invChannels, { fields: [invChannelPools.channelId], references: [invChannels.id] }),
  warehouse: one(invWarehouses, { fields: [invChannelPools.warehouseId], references: [invWarehouses.id] }),
  productVariant: one(invProductVariants, { fields: [invChannelPools.productVariantId], references: [invProductVariants.id] }),
}));
