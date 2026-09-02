import { pgTable, text, serial, timestamp, boolean, decimal, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const salaryStructureTemplates = pgTable("salary_structure_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  basicSalary: decimal("basic_salary", { precision: 15, scale: 2 }).notNull(),
  hraPercent: decimal("hra_percent", { precision: 5, scale: 2 }).default("40").notNull(),
  specialAllowance: decimal("special_allowance", { precision: 15, scale: 2 }).default("0"),
  medicalAllowance: decimal("medical_allowance", { precision: 15, scale: 2 }).default("0"),
  travelAllowance: decimal("travel_allowance", { precision: 15, scale: 2 }).default("0"),
  otherAllowances: decimal("other_allowances", { precision: 15, scale: 2 }).default("0"),
  pfDeductionPercent: decimal("pf_deduction_percent", { precision: 5, scale: 2 }).default("12"),
  professionalTax: decimal("professional_tax", { precision: 10, scale: 2 }).default("200"),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_salary_structure_templates_org_id").on(table.orgId, table.id),
  index("idx_salary_structure_templates_org_active").on(table.orgId, table.isActive),
]);
