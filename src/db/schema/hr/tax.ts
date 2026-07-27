import { pgTable, text, serial, timestamp, boolean, decimal, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const taxDeclarations = pgTable("tax_declarations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  financialYear: text("financial_year").notNull(),
  regime: text("regime").default("NEW").notNull(),
  hra: decimal("hra", { precision: 15, scale: 2 }).default("0").notNull(),
  lta: decimal("lta", { precision: 15, scale: 2 }).default("0").notNull(),
  section80c: decimal("section_80c", { precision: 15, scale: 2 }).default("0").notNull(),
  section80d: decimal("section_80d", { precision: 15, scale: 2 }).default("0").notNull(),
  section80g: decimal("section_80g", { precision: 15, scale: 2 }).default("0").notNull(),
  homeLoanInterest: decimal("home_loan_interest", { precision: 15, scale: 2 }).default("0").notNull(),
  previousEmploymentIncome: decimal("previous_employment_income", { precision: 15, scale: 2 }).default("0").notNull(),
  previousEmployerTds: decimal("previous_employer_tds", { precision: 15, scale: 2 }).default("0").notNull(),
  status: text("status").default("DRAFT").notNull(),
  verifiedBy: text("verified_by").references(() => users.id),
  verifiedAt: timestamp("verified_at"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_tax_declarations_org_id").on(table.orgId, table.id),
  index("idx_tax_declarations_org_year").on(table.orgId, table.financialYear),
  index("idx_tax_declarations_user").on(table.userId),
]);

export const investmentProofs = pgTable("investment_proofs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  declarationId: integer("declaration_id").references(() => taxDeclarations.id, { onDelete: "cascade" }).notNull(),
  category: text("category").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  description: text("description"),
  proofUrl: text("proof_url"),
  status: text("status").default("PENDING").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_investment_proofs_org_id").on(table.orgId, table.id),
  index("idx_investment_proofs_declaration").on(table.declarationId),
]);
