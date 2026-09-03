import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  timestamp,
  date,
  boolean,
  jsonb,
  decimal,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { workers } from "../directory/workers";
import { payrollRuns } from "./runs";

export const payrollEntityStatusEnum = pgEnum("payroll_entity_status", [
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
]);

export const payrollPeriodStatusEnum = pgEnum("payroll_period_status", [
  "OPEN",
  "CUTOFF",
  "LOCKED",
  "CLOSED",
]);

export const payrollJobStatusEnum = pgEnum("payroll_job_status", [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTER",
]);

/** Legal entity / establishment for multi-entity payroll. */
export const payrollEntities = pgTable(
  "payroll_entities",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    legalName: text("legal_name").notNull(),
    countryCode: text("country_code").notNull().default("IN"),
    stateCode: text("state_code"),
    baseCurrency: text("base_currency").notNull().default("INR"),
    pan: text("pan"),
    tan: text("tan"),
    pfEstablishmentCode: text("pf_establishment_code"),
    esiCode: text("esi_code"),
    ptStateCode: text("pt_state_code"),
    status: payrollEntityStatusEnum("status").default("ACTIVE").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_payroll_entities_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_entities_org_legal_name").on(table.orgId, table.legalName),
    index("idx_payroll_entities_org_status").on(table.orgId, table.status),
  ],
);

/** Pay period with cutoff, pay date, and working calendar snapshot. */
export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),
    periodKey: text("period_key").notNull(), // YYYY-MM
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    cutoffAt: timestamp("cutoff_at"),
    payDate: date("pay_date"),
    status: payrollPeriodStatusEnum("status").default("OPEN").notNull(),
    workingDays: decimal("working_days", { precision: 5, scale: 1 }),
    calendarSnapshot: jsonb("calendar_snapshot").$type<Record<string, unknown>>(),
    lockedAt: timestamp("locked_at"),
    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.entityId], foreignColumns: [payrollEntities.orgId, payrollEntities.id], name: "fk_payroll_periods_entity_id_org" }).onDelete("set null"),
    unique("uniq_payroll_periods_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_periods_org_entity_key").on(
      table.orgId,
      table.entityId,
      table.periodKey,
    ),
    index("idx_payroll_periods_org_status").on(table.orgId, table.status),
    index("idx_payroll_periods_org_key").on(table.orgId, table.periodKey),
  ],
);

/** Filing artifacts / challan / acknowledgement / reconciliation. */
export const payrollFilings = pgTable(
  "payroll_filings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),
    periodId: integer("period_id"),
    fiscalYear: text("fiscal_year"),
    filingType: text("filing_type").notNull(), // PF_ECR | ESI | PT | TDS_24Q | FORM16 | LWF
    ruleVersion: text("rule_version"),
    status: text("status").notNull().default("DRAFT"),
    // DRAFT | EXPORT_PREPARED | SUBMITTED | ACKNOWLEDGED | RECONCILED | FAILED
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    artifactKey: text("artifact_key"),
    challanRef: text("challan_ref"),
    acknowledgementRef: text("acknowledgement_ref"),
    externalFilingRequired: boolean("external_filing_required").default(true).notNull(),
    statusLabel: text("status_label").default("Export prepared — external filing required"),
    submittedAt: timestamp("submitted_at"),
    reconciledAt: timestamp("reconciled_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.entityId], foreignColumns: [payrollEntities.orgId, payrollEntities.id], name: "fk_payroll_filings_entity_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.periodId], foreignColumns: [payrollPeriods.orgId, payrollPeriods.id], name: "fk_payroll_filings_period_id_org" }).onDelete("set null"),
    unique("uniq_payroll_filings_org_id").on(table.orgId, table.id),
    index("idx_payroll_filings_org_type").on(table.orgId, table.filingType),
    index("idx_payroll_filings_org_period").on(table.orgId, table.periodId),
    uniqueIndex("uniq_payroll_filings_entity_period_type").on(
      table.orgId,
      table.entityId,
      table.periodId,
      table.filingType,
    ),
  ],
);

/** Durable async jobs for preview/calc/PDF/export. */
export const payrollJobs = pgTable(
  "payroll_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),
    jobType: text("job_type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    status: payrollJobStatusEnum("status").default("PENDING").notNull(),
    progress: integer("progress").default(0).notNull(),
    attempt: integer("attempt").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    errorMessage: text("error_message"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.entityId], foreignColumns: [payrollEntities.orgId, payrollEntities.id], name: "fk_payroll_jobs_entity_id_org" }).onDelete("set null"),
    unique("uniq_payroll_jobs_org_id").on(table.orgId, table.id),
    index("idx_payroll_jobs_org_status").on(table.orgId, table.status),
    index("idx_payroll_jobs_correlation").on(table.correlationId),
    uniqueIndex("uniq_payroll_jobs_org_idem").on(table.orgId, table.idempotencyKey),
  ],
);

/** Run-scoped unique allocation of reimbursements/bonuses/loans/adjustments. */
export const payrollRunAllocations = pgTable(
  "payroll_run_allocations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: integer("run_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // REIMBURSEMENT | BONUS | INCENTIVE | LOAN | ADJUSTMENT
    sourceId: text("source_id").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_payroll_run_allocations_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_run_allocations_source").on(
      table.orgId,
      table.sourceType,
      table.sourceId,
    ),
    index("idx_payroll_run_allocations_run").on(table.orgId, table.runId),
  ],
);

/** Employee TDS YTD ledger for accurate monthly tax. */
export const payrollTdsYtdLedger = pgTable(
  "payroll_tds_ytd_ledger",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id"),
    fiscalYear: text("fiscal_year").notNull(),
    periodKey: text("period_key").notNull(),
    runId: integer("run_id").notNull(),
    taxableIncomePaise: integer("taxable_income_paise").default(0).notNull(),
    tdsPaise: integer("tds_paise").default(0).notNull(),
    previousEmployerIncomePaise: integer("previous_employer_income_paise").default(0).notNull(),
    previousEmployerTdsPaise: integer("previous_employer_tds_paise").default(0).notNull(),
    perquisitesPaise: integer("perquisites_paise").default(0).notNull(),
    surchargePaise: integer("surcharge_paise").default(0).notNull(),
    rebatePaise: integer("rebate_paise").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_payroll_tds_ytd_ledger_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_payroll_tds_ytd_user_period")
      .on(table.orgId, table.userId, table.fiscalYear, table.periodKey, table.runId)
      .where(sql`user_id IS NOT NULL`),
    uniqueIndex("uniq_payroll_tds_ytd_worker_period")
      .on(table.orgId, table.workerId, table.fiscalYear, table.periodKey, table.runId)
      .where(sql`worker_id IS NOT NULL`),
    index("idx_payroll_tds_ytd_user_fy").on(table.orgId, table.userId, table.fiscalYear),
    index("idx_payroll_tds_ytd_worker_fy").on(table.orgId, table.workerId, table.fiscalYear),
    check(
      "chk_payroll_tds_ytd_ledger_subject",
      sql`user_id IS NOT NULL OR worker_id IS NOT NULL`,
    ),
    foreignKey({
      columns: [table.orgId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_payroll_tds_ytd_ledger_org_worker",
    }).onDelete("restrict"),
    // No onDelete, deliberately (migration 1026). 1030's `guard_paid_payroll_tds_ytd_row`
    // is a BEFORE DELETE OR UPDATE guard that forbids changing `run_id` on a paid run, so
    // SET NULL (an UPDATE) and CASCADE (a DELETE) would both raise 23514 the moment a paid
    // run was deleted. NO ACTION never touches the child row, and it states the right rule:
    // a run whose withheld tax is on the year-to-date ledger is not deletable.
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [payrollRuns.orgId, payrollRuns.id],
      name: "fk_payroll_tds_ytd_ledger_run_id_org",
    }),
    index("idx_payroll_tds_ytd_ledger_org_run").on(table.orgId, table.runId),
  ],
);

export const payrollEntitiesRelations = relations(payrollEntities, ({ many }) => ({
  periods: many(payrollPeriods),
}));

export const payrollPeriodsRelations = relations(payrollPeriods, ({ one }) => ({
  entity: one(payrollEntities, {
    fields: [payrollPeriods.entityId],
    references: [payrollEntities.id],
  }),
}));
