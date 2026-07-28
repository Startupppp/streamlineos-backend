import { pgTable, text, integer, serial, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { orgUnits } from "../common/organization";
import { jobRequisitions } from "./requisitions";

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
    linkedRequisitionId: integer("linked_requisition_id").references(() => jobRequisitions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_hr_hiring_plan_items_org_id").on(table.orgId, table.id),
    index("idx_hr_hiring_plan_items_plan").on(table.planId),
    index("idx_hr_hiring_plan_items_org").on(table.orgId),
  ],
);

export const hrHeadcountPlansRelations = relations(hrHeadcountPlans, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [hrHeadcountPlans.orgId],
    references: [organizations.id],
  }),
  department: one(orgUnits, {
    fields: [hrHeadcountPlans.departmentId],
    references: [orgUnits.id],
  }),
  hiringItems: many(hrHiringPlanItems),
}));

export const hrHiringPlanItemsRelations = relations(hrHiringPlanItems, ({ one }) => ({
  plan: one(hrHeadcountPlans, {
    fields: [hrHiringPlanItems.planId],
    references: [hrHeadcountPlans.id],
  }),
}));
