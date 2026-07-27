import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  date,
  index,
  uniqueIndex,
  numeric,
  unique,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { departments } from "./employees";
import { hrLocations } from "./core-org";

// ─── Pack 1: Time Clock Devices ─────────────────────────────────────────────

export const hrTimeDeviceTypeEnum = pgEnum("hr_time_device_type", [
  "biometric",
  "rfid",
  "mobile",
  "other",
]);

export const hrTimeDeviceStatusEnum = pgEnum("hr_time_device_status", [
  "active",
  "inactive",
  "faulty",
]);

export const hrDeviceSyncStatusEnum = pgEnum("hr_device_sync_status", [
  "success",
  "failed",
  "partial",
]);

export const hrTimeDevices = pgTable(
  "hr_time_devices",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serialNumber: text("serial_number").notNull(),
    type: hrTimeDeviceTypeEnum("type").notNull(),
    locationId: integer("location_id").references(() => hrLocations.id, { onDelete: "set null" }),
    status: hrTimeDeviceStatusEnum("status").default("active").notNull(),
    lastSyncAt: timestamp("last_sync_at"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_time_devices_org_id").on(t.orgId, t.id),
    index("idx_hr_time_devices_org_status").on(t.orgId, t.status),
    uniqueIndex("uniq_hr_time_devices_org_serial").on(t.orgId, t.serialNumber),
  ],
);

export const hrDeviceSyncLogs = pgTable(
  "hr_device_sync_logs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: integer("device_id")
      .notNull()
      .references(() => hrTimeDevices.id, { onDelete: "cascade" }),
    status: hrDeviceSyncStatusEnum("status").notNull(),
    recordsCount: integer("records_count").default(0).notNull(),
    error: text("error"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_device_sync_logs_org_id").on(t.orgId, t.id),
    index("idx_hr_device_sync_logs_org_device").on(t.orgId, t.deviceId),
    index("idx_hr_device_sync_logs_status").on(t.orgId, t.status),
  ],
);

export const hrDeviceEmployeeMappings = pgTable(
  "hr_device_employee_mappings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: integer("device_id")
      .notNull()
      .references(() => hrTimeDevices.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    biometricId: text("biometric_id"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_device_employee_mappings_org_id").on(t.orgId, t.id),
    index("idx_hr_device_emp_mappings_org_device").on(t.orgId, t.deviceId),
    index("idx_hr_device_emp_mappings_org_user").on(t.orgId, t.userId),
  ],
);

// ─── Pack 2: Advanced Payroll Compliance ────────────────────────────────────

export const hrVarianceApprovalStatusEnum = pgEnum(
  "hr_variance_approval_status",
  ["pending", "approved", "rejected"],
);

export const hrArrearsStatusEnum = pgEnum("hr_arrears_status", [
  "pending",
  "applied",
]);

export const hrComplianceTaskStatusEnum = pgEnum("hr_compliance_task_status", [
  "pending",
  "completed",
  "overdue",
]);

export const hrPayrollVarianceApprovals = pgTable(
  "hr_payroll_variance_approvals",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    payrollPeriodKey: text("payroll_period_key").notNull(),
    variancePct: numeric("variance_pct", { precision: 8, scale: 4 }).notNull(),
    thresholdPct: numeric("threshold_pct", { precision: 8, scale: 4 }).notNull(),
    status: hrVarianceApprovalStatusEnum("status").default("pending").notNull(),
    approverId: text("approver_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [
    unique("uniq_hr_payroll_variance_approvals_org_id").on(t.orgId, t.id),
    index("idx_hr_payroll_variance_org_period").on(t.orgId, t.payrollPeriodKey),
    index("idx_hr_payroll_variance_status").on(t.orgId, t.status),
  ],
);

export const hrArrearsAdjustments = pgTable(
  "hr_arrears_adjustments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    sourcePeriod: text("source_period").notNull(),
    targetPeriod: text("target_period").notNull(),
    status: hrArrearsStatusEnum("status").default("pending").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_arrears_adjustments_org_id").on(t.orgId, t.id),
    index("idx_hr_arrears_org_user").on(t.orgId, t.userId),
    index("idx_hr_arrears_org_status").on(t.orgId, t.status),
  ],
);

export const hrPayrollComplianceTasks = pgTable(
  "hr_payroll_compliance_tasks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    countryCode: text("country_code").notNull(),
    name: text("name").notNull(),
    dueDate: date("due_date").notNull(),
    status: hrComplianceTaskStatusEnum("status").default("pending").notNull(),
    notes: text("notes"),
    completedBy: text("completed_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_payroll_compliance_tasks_org_id").on(t.orgId, t.id),
    index("idx_hr_compliance_tasks_org_country").on(t.orgId, t.countryCode),
    index("idx_hr_compliance_tasks_org_status").on(t.orgId, t.status),
  ],
);

// ─── Pack 3: Compensation Planning ──────────────────────────────────────────

export const hrCompCycleStatusEnum = pgEnum("hr_comp_cycle_status", [
  "draft",
  "active",
  "calibrating",
  "approved",
  "closed",
]);

export const hrCompRecommendationStatusEnum = pgEnum(
  "hr_comp_recommendation_status",
  ["draft", "submitted", "calibrated", "approved"],
);

export const hrCompCycles = pgTable(
  "hr_comp_cycles",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    status: hrCompCycleStatusEnum("status").default("draft").notNull(),
    budgetPoolCents: bigint("budget_pool_cents", { mode: "number" }).notNull(),
    meritMatrix: jsonb("merit_matrix"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_comp_cycles_org_id").on(t.orgId, t.id),
    index("idx_hr_comp_cycles_org_status").on(t.orgId, t.status),
    uniqueIndex("uniq_hr_comp_cycles_org_year_name").on(t.orgId, t.fiscalYear, t.name),
  ],
);

export const hrCompRecommendations = pgTable(
  "hr_comp_recommendations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => hrCompCycles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    currentSalaryCents: bigint("current_salary_cents", { mode: "number" }).notNull(),
    recommendedIncreaseCents: bigint("recommended_increase_cents", { mode: "number" }).notNull(),
    recommendedPct: numeric("recommended_pct", { precision: 8, scale: 4 }).notNull(),
    rating: text("rating"),
    managerNote: text("manager_note"),
    hrCalibratedCents: bigint("hr_calibrated_cents", { mode: "number" }),
    status: hrCompRecommendationStatusEnum("status").default("draft").notNull(),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    calibratedBy: text("calibrated_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_comp_recommendations_org_id").on(t.orgId, t.id),
    index("idx_hr_comp_recs_org_cycle").on(t.orgId, t.cycleId),
    index("idx_hr_comp_recs_org_user").on(t.orgId, t.userId),
    uniqueIndex("uniq_hr_comp_recs_cycle_user").on(t.cycleId, t.userId),
  ],
);

export const hrCompBudgetPools = pgTable(
  "hr_comp_budget_pools",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => hrCompCycles.id, { onDelete: "cascade" }),
    departmentId: integer("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    allocatedCents: bigint("allocated_cents", { mode: "number" }).notNull(),
    usedCents: bigint("used_cents", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_comp_budget_pools_org_id").on(t.orgId, t.id),
    index("idx_hr_comp_budget_pools_org_cycle").on(t.orgId, t.cycleId),
  ],
);

// ─── Pack 4: Equity / ESOP ───────────────────────────────────────────────────

export const hrEquityGrantTypeEnum = pgEnum("hr_equity_grant_type", [
  "ISO",
  "NSO",
  "RSU",
  "other",
]);

export const hrEquityGrantStatusEnum = pgEnum("hr_equity_grant_status", [
  "active",
  "exercised",
  "cancelled",
  "expired",
]);

export const hrEquityGrants = pgTable(
  "hr_equity_grants",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantType: hrEquityGrantTypeEnum("grant_type").notNull(),
    units: integer("units").notNull(),
    strikePriceCents: bigint("strike_price_cents", { mode: "number" }),
    grantDate: date("grant_date").notNull(),
    cliffMonths: integer("cliff_months").notNull(),
    vestingMonths: integer("vesting_months").notNull(),
    status: hrEquityGrantStatusEnum("status").default("active").notNull(),
    boardApprovedAt: timestamp("board_approved_at"),
    documentUrl: text("document_url"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_equity_grants_org_id").on(t.orgId, t.id),
    index("idx_hr_equity_grants_org_user").on(t.orgId, t.userId),
    index("idx_hr_equity_grants_org_status").on(t.orgId, t.status),
  ],
);

export const hrEquityVestingEvents = pgTable(
  "hr_equity_vesting_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: integer("grant_id")
      .notNull()
      .references(() => hrEquityGrants.id, { onDelete: "cascade" }),
    vestDate: date("vest_date").notNull(),
    unitsVested: integer("units_vested").notNull(),
    cumulativeVested: integer("cumulative_vested").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_equity_vesting_events_org_id").on(t.orgId, t.id),
    index("idx_hr_equity_vesting_events_grant").on(t.grantId),
    index("idx_hr_equity_vesting_events_org_grant").on(t.orgId, t.grantId),
  ],
);

export const hrEquityExercises = pgTable(
  "hr_equity_exercises",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: integer("grant_id")
      .notNull()
      .references(() => hrEquityGrants.id, { onDelete: "cascade" }),
    exerciseDate: date("exercise_date").notNull(),
    units: integer("units").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_hr_equity_exercises_org_id").on(t.orgId, t.id),
    index("idx_hr_equity_exercises_org_grant").on(t.orgId, t.grantId),
  ],
);
