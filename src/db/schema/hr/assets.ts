import { pgTable, text, serial, timestamp, decimal, date, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assetStatusEnum } from "../enums";
import { organizations, users } from "../auth";

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  brand: text("brand"),
  model: text("model"),
  serialNumber: text("serial_number"),
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  status: assetStatusEnum("status").default("AVAILABLE").notNull(),
  purchaseDate: date("purchase_date"),
  purchaseCost: decimal("purchase_cost", { precision: 15, scale: 2 }),
  location: text("location"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_assets_org_status").on(table.orgId, table.status),
  index("idx_assets_assigned").on(table.assignedTo),
]);

export const assetsRelations = relations(assets, ({ one }) => ({
  assignedUser: one(users, { fields: [assets.assignedTo], references: [users.id] }),
}));
