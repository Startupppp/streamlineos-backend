import { pgTable, text, serial, timestamp, decimal, integer, boolean, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invChannelTypeEnum, invChannelStatusEnum, invChannelPubStatusEnum, inv3plStatusEnum } from "../enums";
import { organizations } from "../auth";
import { invProductVariants } from "./core";

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_channels_org_name").on(table.orgId, table.name),
  unique("uniq_inv_channels_org_id").on(table.orgId, table.id),
  index("idx_inv_channels_org_status").on(table.orgId, table.status),
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
  unique("uniq_inv_channel_stock_pub_org_id").on(table.orgId, table.id),
  index("idx_inv_pub_org_channel").on(table.orgId, table.channelId),
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
