import { pgTable, text, serial, timestamp, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invSoStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { clients } from "../crm/contacts";
import { invoices } from "../crm/billing";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";

export const invSalesOrders = pgTable("inv_sales_orders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  soNumber: text("so_number").notNull(),
  status: invSoStatusEnum("status").default("DRAFT").notNull(),
  orderDate: date("order_date").notNull(),
  requiredDate: date("required_date"),
  shippingAddress: text("shipping_address"),
  warehouseId: integer("warehouse_id").references(() => invWarehouses.id, { onDelete: "set null" }),
  subtotal: decimal("subtotal", { precision: 18, scale: 4 }).default("0").notNull(),
  taxAmount: decimal("tax_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  discount: decimal("discount", { precision: 18, scale: 4 }).default("0").notNull(),
  total: decimal("total", { precision: 18, scale: 4 }).default("0").notNull(),
  currency: text("currency").default("INR").notNull(),
  notes: text("notes"),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at"),
  shippedAt: timestamp("shipped_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_so_org_number").on(table.orgId, table.soNumber),
  index("idx_inv_so_org_status").on(table.orgId, table.status),
  index("idx_inv_so_client").on(table.clientId),
  index("idx_inv_so_warehouse").on(table.warehouseId),
]);

export const invSoLines = pgTable("inv_so_lines", {
  id: serial("id").primaryKey(),
  soId: integer("so_id").references(() => invSalesOrders.id, { onDelete: "cascade" }).notNull(),
  productVariantId: integer("product_variant_id").references(() => invProductVariants.id, { onDelete: "restrict" }).notNull(),
  quantity: decimal("quantity", { precision: 18, scale: 4 }).notNull(),
  quantityShipped: decimal("quantity_shipped", { precision: 18, scale: 4 }).default("0").notNull(),
  unitPrice: decimal("unit_price", { precision: 18, scale: 4 }).notNull(),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  costAtTime: decimal("cost_at_time", { precision: 18, scale: 4 }).default("0").notNull(),
  lineOrder: integer("line_order").default(0).notNull(),
}, (table) => [
  index("idx_inv_so_lines_so").on(table.soId),
]);

export const invSalesOrdersRelations = relations(invSalesOrders, ({ one, many }) => ({
  organization: one(organizations, { fields: [invSalesOrders.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [invSalesOrders.clientId], references: [clients.id] }),
  warehouse: one(invWarehouses, { fields: [invSalesOrders.warehouseId], references: [invWarehouses.id] }),
  invoice: one(invoices, { fields: [invSalesOrders.invoiceId], references: [invoices.id] }),
  creator: one(users, { fields: [invSalesOrders.createdBy], references: [users.id] }),
  lines: many(invSoLines),
}));

export const invSoLinesRelations = relations(invSoLines, ({ one }) => ({
  salesOrder: one(invSalesOrders, { fields: [invSoLines.soId], references: [invSalesOrders.id] }),
  productVariant: one(invProductVariants, { fields: [invSoLines.productVariantId], references: [invProductVariants.id] }),
}));
