import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  decimal,
  date,
  index,
  unique,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { leaveTypes } from "./leaves";

export const hrLeaveTxnTypeEnum = pgEnum("hr_leave_txn_type", [
  "accrual",
  "consumption",
  "carry_forward",
  "encashment",
  "expiry",
  "adjustment",
  "comp_off_earn",
  "comp_off_use",
  "reversal",
]);

export const hrLeaveLedgerSourceEnum = pgEnum("hr_leave_ledger_source", [
  "policy_accrual",
  "request",
  "cron",
  "manual",
  "import",
]);

export const hrLeavePayrollStatusEnum = pgEnum("hr_leave_payroll_status", [
  "pending",
  "exported",
  "locked",
]);

export const hrLeaveLedger = pgTable(
  "hr_leave_ledger",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      ,
    userMembershipId: integer("user_membership_id"),
    leaveTypeId: integer("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id, { onDelete: "restrict" }),
    txnType: hrLeaveTxnTypeEnum("txn_type").notNull(),
    days: decimal("days", { precision: 8, scale: 2 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    period: text("period"),
    source: hrLeaveLedgerSourceEnum("source").notNull(),
    sourceId: text("source_id"),
    note: text("note"),
    payrollStatus: hrLeavePayrollStatusEnum("payroll_status").notNull().default("pending"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_leave_ledger_org_id").on(table.orgId, table.id),
    index("idx_hr_leave_ledger_user_type_date").on(
      table.orgId,
      table.userId,
      table.leaveTypeId,
      table.effectiveDate,
    ),
    index("idx_hr_leave_ledger_payroll_status").on(table.orgId, table.payrollStatus),
    index("idx_hr_leave_ledger_org_user").on(table.orgId, table.userId),
  ],
);

export const hrLeaveLedgerRelations = relations(hrLeaveLedger, ({ one }) => ({
  organization: one(organizations, {
    fields: [hrLeaveLedger.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [hrLeaveLedger.userId],
    references: [users.id],
  }),
  leaveType: one(leaveTypes, {
    fields: [hrLeaveLedger.leaveTypeId],
    references: [leaveTypes.id],
  }),
}));
