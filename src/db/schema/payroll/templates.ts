import {
  pgTable, serial, text, boolean, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { payrollTemplateCategoryEnum } from "./enums";

export const payrollTemplates = pgTable("payroll_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key"),
  name: text("name").notNull(),
  description: text("description"),
  bestFor: text("best_for"),
  complexity: text("complexity"),
  badge: text("badge"),
  category: payrollTemplateCategoryEnum("category").notNull().default("CUSTOM"),
  defaultToggles: jsonb("default_toggles").$type<object>().notNull(),
  defaultComponents: jsonb("default_components").$type<unknown[]>().notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  isRecommended: boolean("is_recommended").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_payroll_templates_org").on(table.orgId),
  index("idx_payroll_templates_system").on(table.isSystem),
  index("idx_payroll_templates_category").on(table.category),
]);

export const payrollTemplatesRelations = relations(payrollTemplates, ({ one }) => ({
  organization: one(organizations, {
    fields: [payrollTemplates.orgId],
    references: [organizations.id],
  }),
}));
