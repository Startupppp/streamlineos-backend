import { pgTable, text, serial, timestamp, boolean, decimal, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../auth";

export const allowanceTypes = pgTable("allowance_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  formulaType: text("formula_type").default("FIXED").notNull(),
  value: decimal("value", { precision: 10, scale: 4 }),
  cap: decimal("cap", { precision: 15, scale: 2 }),
  isTaxable: boolean("is_taxable").default(true).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_allowance_types_org_name").on(table.orgId, table.name),
  index("idx_allowance_types_org_category").on(table.orgId, table.category),
]);
