import { foreignKey, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
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
    departmentId: text("department_id"),
    budgetedHeadcount: integer("budgeted_headcount").notNull(),
    budgetedCostCents: integer("budgeted_cost_cents"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.departmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_hr_headcount_plans_org_department" }).onDelete("set null"),
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
