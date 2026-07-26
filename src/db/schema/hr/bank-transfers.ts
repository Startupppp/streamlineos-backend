import { pgTable, text, serial, timestamp, decimal, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export type BankTransferEntry = {
  userId: string;
  amount: number;
  bankAccount: string;
  ifscCode: string;
  employeeName: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
};

export const bankTransfers = pgTable("bank_transfers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  month: text("month").notNull(),
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
  employeeCount: integer("employee_count").notNull(),
  status: text("status").default("PENDING").notNull(),
  bankFileUrl: text("bank_file_url"),
  referenceNo: text("reference_no"),
  processedAt: timestamp("processed_at"),
  createdBy: text("created_by").references(() => users.id),
  entries: jsonb("entries").$type<BankTransferEntry[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_bank_transfers_org_id").on(table.orgId, table.id),
  index("idx_bank_transfers_org_month").on(table.orgId, table.month),
  index("idx_bank_transfers_org_status").on(table.orgId, table.status),
]);
