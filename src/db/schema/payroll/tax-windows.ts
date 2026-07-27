import {
  pgTable, serial, text, timestamp, date, index, uniqueIndex, unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { payrollTaxWindowStatusEnum } from "./enums";

export const payrollTaxWindows = pgTable("payroll_tax_windows", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  financialYear: text("financial_year").notNull(),
  opensAt: timestamp("opens_at").notNull(),
  closesAt: timestamp("closes_at").notNull(),
  proofDeadline: timestamp("proof_deadline"),
  lockDate: date("lock_date"),
  status: payrollTaxWindowStatusEnum("status").notNull().default("DRAFT"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payroll_tax_windows_org_id").on(table.orgId, table.id),
  index("idx_payroll_tax_windows_org").on(table.orgId),
  uniqueIndex("uniq_payroll_tax_windows_org_year").on(table.orgId, table.financialYear),
]);

export const payrollTaxWindowsRelations = relations(payrollTaxWindows, ({ one }) => ({
  organization: one(organizations, {
    fields: [payrollTaxWindows.orgId],
    references: [organizations.id],
  }),
}));
