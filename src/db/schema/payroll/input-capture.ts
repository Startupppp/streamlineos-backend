import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  jsonb,
  bigint,
  numeric,
  date,
  integer,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";

export const hrPayrollInputStatusEnum = pgEnum("hr_payroll_input_status", [
  "open",
  "building",
  "built",
  "locked",
]);

export const hrPayrollInputSectionEnum = pgEnum("hr_payroll_input_section", [
  "employee_master",
  "compensation",
  "attendance",
  "leave",
  "overtime",
  "reimbursement",
  "deduction",
  "lifecycle",
]);

export const hrPayrollAdjustmentTypeEnum = pgEnum("hr_payroll_adjustment_type", [
  "arrears",
  "recovery",
  "correction",
]);

export const hrPayrollAdjustmentStatusEnum = pgEnum("hr_payroll_adjustment_status", [
  "pending",
  "approved",
  "applied",
  "rejected",
]);

export const hrPayrollInputPeriods = pgTable(
  "hr_payroll_input_periods",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    status: hrPayrollInputStatusEnum("status").default("open").notNull(),
    cutoffDate: date("cutoff_date"),
    builtAt: timestamp("built_at"),
    lockedAt: timestamp("locked_at"),
    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_hr_payroll_input_periods_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_payroll_input_periods_org_key").on(table.orgId, table.periodKey),
    index("idx_hr_payroll_input_periods_org_status").on(table.orgId, table.status),
  ],
);

export const hrPayrollInputSnapshots = pgTable(
  "hr_payroll_input_snapshots",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: integer("period_id")
      .notNull()
      .references(() => hrPayrollInputPeriods.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    userMembershipId: integer("user_membership_id"),
    section: hrPayrollInputSectionEnum("section").notNull(),
    payload: jsonb("payload").notNull(),
    sourceRefs: jsonb("source_refs"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_payroll_input_snapshots_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_payroll_input_snapshots_period_user_section").on(
      table.periodId,
      table.userId,
      table.section,
    ),
    index("idx_hr_payroll_input_snapshots_org_period_user").on(
      table.orgId,
      table.periodId,
      table.userId,
    ),
    index("idx_hr_payroll_input_snapshots_org_user_actor").on(table.orgId, table.userMembershipId),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_payroll_input_snapshots_user_actor",
    }).onDelete("set null"),
  ],
);

export const hrPayrollAdjustments = pgTable(
  "hr_payroll_adjustments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: integer("period_id").references(() => hrPayrollInputPeriods.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").notNull(),
    userMembershipId: integer("user_membership_id"),
    adjustmentType: hrPayrollAdjustmentTypeEnum("adjustment_type").notNull(),
    section: hrPayrollInputSectionEnum("section").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }),
    days: numeric("days", { precision: 8, scale: 2 }),
    reason: text("reason").notNull(),
    sourceChangeRef: jsonb("source_change_ref"),
    status: hrPayrollAdjustmentStatusEnum("status").default("pending").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at"),
    rejectedBy: text("rejected_by").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_hr_payroll_adjustments_org_id").on(table.orgId, table.id),
    index("idx_hr_payroll_adjustments_org_status").on(table.orgId, table.status),
    index("idx_hr_payroll_adjustments_org_period").on(table.orgId, table.periodId),
    index("idx_hr_payroll_adjustments_org_user").on(table.orgId, table.userId),
    index("idx_hr_payroll_adjustments_org_user_actor").on(table.orgId, table.userMembershipId),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_payroll_adjustments_user_actor",
    }).onDelete("set null"),
  ],
);

export const hrPayrollInputPeriodsRelations = relations(hrPayrollInputPeriods, ({ one, many }) => ({
  org: one(organizations, { fields: [hrPayrollInputPeriods.orgId], references: [organizations.id] }),
  lockedByUser: one(users, {
    fields: [hrPayrollInputPeriods.lockedBy],
    references: [users.id],
    relationName: "periodLockedBy",
  }),
  createdByUser: one(users, {
    fields: [hrPayrollInputPeriods.createdBy],
    references: [users.id],
    relationName: "periodCreatedBy",
  }),
  snapshots: many(hrPayrollInputSnapshots),
  adjustments: many(hrPayrollAdjustments),
}));

export const hrPayrollInputSnapshotsRelations = relations(hrPayrollInputSnapshots, ({ one }) => ({
  period: one(hrPayrollInputPeriods, {
    fields: [hrPayrollInputSnapshots.periodId],
    references: [hrPayrollInputPeriods.id],
  }),
  user: one(users, { fields: [hrPayrollInputSnapshots.userId], references: [users.id] }),
}));

export const hrPayrollAdjustmentsRelations = relations(hrPayrollAdjustments, ({ one }) => ({
  period: one(hrPayrollInputPeriods, {
    fields: [hrPayrollAdjustments.periodId],
    references: [hrPayrollInputPeriods.id],
  }),
  user: one(users, {
    fields: [hrPayrollAdjustments.userId],
    references: [users.id],
    relationName: "adjUser",
  }),
  createdByUser: one(users, {
    fields: [hrPayrollAdjustments.createdBy],
    references: [users.id],
    relationName: "adjCreatedBy",
  }),
  approvedByUser: one(users, {
    fields: [hrPayrollAdjustments.approvedBy],
    references: [users.id],
    relationName: "adjApprovedBy",
  }),
}));
