import { pgTable, text, integer, serial, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { departments } from "./employees";

export const hrHeadcountPlans = pgTable(
  "hr_headcount_plans",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYear: integer("fiscal_year").notNull(),
    departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
    budgetedHeadcount: integer("budgeted_headcount").notNull(),
    budgetedCostCents: integer("budgeted_cost_cents"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_headcount_plans_org_year_dept").on(table.orgId, table.fiscalYear, table.departmentId),
    index("idx_hr_headcount_plans_org").on(table.orgId),
  ],
);

export const hrHiringPlanItems = pgTable(
  "hr_hiring_plan_items",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: integer("plan_id")
      .notNull()
      .references(() => hrHeadcountPlans.id, { onDelete: "cascade" }),
    roleTitle: text("role_title").notNull(),
    count: integer("count").notNull().default(1),
    targetQuarter: integer("target_quarter"),
    status: text("status").notNull().default("planned"),
    linkedRequisitionId: integer("linked_requisition_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_hr_hiring_plan_items_plan").on(table.planId),
    index("idx_hr_hiring_plan_items_org").on(table.orgId),
  ],
);

export const hrHeadcountPlansRelations = relations(hrHeadcountPlans, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [hrHeadcountPlans.orgId],
    references: [organizations.id],
  }),
  department: one(departments, {
    fields: [hrHeadcountPlans.departmentId],
    references: [departments.id],
  }),
  hiringItems: many(hrHiringPlanItems),
}));

export const hrHiringPlanItemsRelations = relations(hrHiringPlanItems, ({ one }) => ({
  plan: one(hrHeadcountPlans, {
    fields: [hrHiringPlanItems.planId],
    references: [hrHeadcountPlans.id],
  }),
}));
