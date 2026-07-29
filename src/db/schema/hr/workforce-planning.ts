import { pgTable, text, integer, serial, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { orgUnits } from "../common/organization";

export const hrHeadcountPlans = pgTable(
  "hr_headcount_plans",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYear: integer("fiscal_year").notNull(),
    departmentId: text("department_id").references(() => orgUnits.id, { onDelete: "set null" }),
    budgetedHeadcount: integer("budgeted_headcount").notNull(),
    budgetedCostCents: integer("budgeted_cost_cents"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_hr_headcount_plans_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_headcount_plans_org_year_dept").on(table.orgId, table.fiscalYear, table.departmentId),
    index("idx_hr_headcount_plans_org").on(table.orgId),
  ],
);

export const hrHeadcountPlansRelations = relations(hrHeadcountPlans, ({ one }) => ({
  organization: one(organizations, {
    fields: [hrHeadcountPlans.orgId],
    references: [organizations.id],
  }),
  department: one(orgUnits, {
    fields: [hrHeadcountPlans.departmentId],
    references: [orgUnits.id],
  }),
}));
