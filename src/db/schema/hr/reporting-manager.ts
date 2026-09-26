import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  smallint,
  uuid,
  date,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { hrEmployments, hrReportingLines, hrReportingLineTypeEnum, type ReportingLineSource } from "./core-people";

export const REPORTING_MANAGER_FALLBACK_ORDERS = [
  "CONFIGURED_MANAGER_THEN_UPLOADER",
  "UPLOADER_THEN_CONFIGURED_MANAGER",
] as const;
export type ReportingManagerFallbackOrder = (typeof REPORTING_MANAGER_FALLBACK_ORDERS)[number];

export const REPORTING_MANAGER_REQUEST_STATUSES = [
  "PENDING",
  "MORE_INFO_REQUIRED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type ReportingManagerRequestStatus = (typeof REPORTING_MANAGER_REQUEST_STATUSES)[number];

export const REPORTING_LINE_BULK_JOB_STATUSES = ["PREVIEWED", "COMMITTING", "COMMITTED", "FAILED", "EXPIRED"] as const;
export type ReportingLineBulkJobStatus = (typeof REPORTING_LINE_BULK_JOB_STATUSES)[number];

export const REPORTING_LINE_BULK_ROW_STATUSES = ["READY", "WARNING", "ERROR", "SKIPPED", "COMMITTED", "FAILED"] as const;
export type ReportingLineBulkRowStatus = (typeof REPORTING_LINE_BULK_ROW_STATUSES)[number];

export const REPORTING_LINE_SUPERSEDED_REASONS = ["REPLACED", "LEGACY_EMPTY_PERIOD"] as const;
export type ReportingLineSupersededReason = (typeof REPORTING_LINE_SUPERSEDED_REASONS)[number];

export const hrReportingManagerPolicies = pgTable("hr_reporting_manager_policies", {
  orgId: text("org_id").primaryKey(),
  maxSecondaryManagersPerEmployee: smallint("max_secondary_managers_per_employee").default(0).notNull(),
  defaultPrimaryManagerUserId: text("default_primary_manager_user_id"),
  fallbackOrder: text("fallback_order").$type<ReportingManagerFallbackOrder>().default("CONFIGURED_MANAGER_THEN_UPLOADER").notNull(),
  requireReasonAfterChanges: smallint("require_reason_after_changes").default(3).notNull(),
  allowTopLevelWithoutManager: boolean("allow_top_level_without_manager").default(true).notNull(),
  version: integer("version").default(1).notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_rm_policies_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.defaultPrimaryManagerUserId], foreignColumns: [organizationMembers.orgId, organizationMembers.userId], name: "fk_hr_rm_policies_default_manager" }).onDelete("set null"),
  index("idx_hr_rm_policies_default_manager").on(table.orgId, table.defaultPrimaryManagerUserId).where(sql`default_primary_manager_user_id IS NOT NULL`),
  check("chk_hr_rm_policies_max_secondary", sql`${table.maxSecondaryManagersPerEmployee} BETWEEN 0 AND 3`),
  check("chk_hr_rm_policies_fallback_order", sql`${table.fallbackOrder} IN ('CONFIGURED_MANAGER_THEN_UPLOADER', 'UPLOADER_THEN_CONFIGURED_MANAGER')`),
  check("chk_hr_rm_policies_reason_after", sql`${table.requireReasonAfterChanges} BETWEEN 1 AND 10`),
  check("chk_hr_rm_policies_version", sql`${table.version} >= 1`),
]);

export const hrReportingLineBulkJobs = pgTable("hr_reporting_line_bulk_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  status: text("status").$type<ReportingLineBulkJobStatus>().default("PREVIEWED").notNull(),
  jobReason: text("job_reason").notNull(),
  effectiveFrom: date("effective_from"),
  rowCount: integer("row_count").default(0).notNull(),
  readyCount: integer("ready_count").default(0).notNull(),
  warningCount: integer("warning_count").default(0).notNull(),
  errorCount: integer("error_count").default(0).notNull(),
  committedCount: integer("committed_count").default(0).notNull(),
  createdBy: text("created_by").notNull(),
  committedBy: text("committed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_rl_bulk_jobs_org" }).onDelete("cascade"),
  unique("uniq_hr_rl_bulk_jobs_org_id").on(table.orgId, table.id),
  index("idx_hr_rl_bulk_jobs_org_created").on(table.orgId, table.createdAt.desc(), table.id.desc()).where(sql`deleted_at IS NULL`),
  check("chk_hr_rl_bulk_jobs_status", sql`${table.status} IN ('PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED', 'EXPIRED')`),
  check("chk_hr_rl_bulk_jobs_reason", sql`char_length(btrim(${table.jobReason})) BETWEEN 10 AND 1000`),
  check("chk_hr_rl_bulk_jobs_counts", sql`${table.rowCount} >= 0 AND ${table.readyCount} >= 0 AND ${table.warningCount} >= 0 AND ${table.errorCount} >= 0 AND ${table.committedCount} >= 0`),
]);

export const hrReportingLineBulkJobRows = pgTable("hr_reporting_line_bulk_job_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  jobId: uuid("job_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  employeeEmail: text("employee_email").notNull(),
  employeeEmploymentId: integer("employee_employment_id"),
  requestedPrimaryManagerEmail: text("requested_primary_manager_email"),
  requestedPrimaryManagerEmploymentId: integer("requested_primary_manager_employment_id"),
  currentPrimaryManagerEmploymentId: integer("current_primary_manager_employment_id"),
  secondaryManagerEmail1: text("secondary_manager_email_1"),
  secondaryManagerEmail2: text("secondary_manager_email_2"),
  secondaryManagerEmail3: text("secondary_manager_email_3"),
  effectiveFrom: date("effective_from"),
  rowReason: text("row_reason"),
  changesLast24h: integer("changes_last_24h").default(0).notNull(),
  status: text("status").$type<ReportingLineBulkRowStatus>().notNull(),
  codes: text("codes"),
  message: text("message"),
  beforeLineId: integer("before_line_id"),
  afterLineId: integer("after_line_id"),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_rl_bulk_job_rows_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.jobId], foreignColumns: [hrReportingLineBulkJobs.orgId, hrReportingLineBulkJobs.id], name: "fk_hr_rl_bulk_job_rows_job" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.employeeEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rl_bulk_job_rows_employee" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.requestedPrimaryManagerEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rl_bulk_job_rows_requested_manager" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.currentPrimaryManagerEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rl_bulk_job_rows_current_manager" }).onDelete("set null"),
  unique("uniq_hr_rl_bulk_job_rows_job_row").on(table.orgId, table.jobId, table.rowNumber),
  index("idx_hr_rl_bulk_job_rows_employee").on(table.orgId, table.employeeEmploymentId).where(sql`employee_employment_id IS NOT NULL`),
  index("idx_hr_rl_bulk_job_rows_requested_manager").on(table.orgId, table.requestedPrimaryManagerEmploymentId).where(sql`requested_primary_manager_employment_id IS NOT NULL`),
  index("idx_hr_rl_bulk_job_rows_current_manager").on(table.orgId, table.currentPrimaryManagerEmploymentId).where(sql`current_primary_manager_employment_id IS NOT NULL`),
  check("chk_hr_rl_bulk_job_rows_row_number", sql`${table.rowNumber} >= 1`),
  check("chk_hr_rl_bulk_job_rows_status", sql`${table.status} IN ('READY', 'WARNING', 'ERROR', 'SKIPPED', 'COMMITTED', 'FAILED')`),
  check("chk_hr_rl_bulk_job_rows_reason", sql`${table.rowReason} IS NULL OR char_length(${table.rowReason}) <= 1000`),
  check("chk_hr_rl_bulk_job_rows_changes", sql`${table.changesLast24h} >= 0`),
]);

export const hrReportingManagerRequests = pgTable("hr_reporting_manager_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  employeeEmploymentId: integer("employee_employment_id").notNull(),
  requestedByUserId: text("requested_by_user_id").notNull(),
  currentPrimaryLineId: integer("current_primary_line_id"),
  suggestedManagerEmploymentId: integer("suggested_manager_employment_id"),
  requestedEffectiveFrom: date("requested_effective_from"),
  employeeReason: text("employee_reason").notNull(),
  status: text("status").$type<ReportingManagerRequestStatus>().default("PENDING").notNull(),
  reviewerUserId: text("reviewer_user_id"),
  reviewReason: text("review_reason"),
  resolvedLineId: integer("resolved_line_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_rm_requests_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.employeeEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rm_requests_employee" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.suggestedManagerEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rm_requests_suggested_manager" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.currentPrimaryLineId], foreignColumns: [hrReportingLines.orgId, hrReportingLines.id], name: "fk_hr_rm_requests_current_line" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.resolvedLineId], foreignColumns: [hrReportingLines.orgId, hrReportingLines.id], name: "fk_hr_rm_requests_resolved_line" }).onDelete("set null"),
  unique("uniq_hr_rm_requests_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_rm_requests_active").on(table.orgId, table.employeeEmploymentId, sql`(coalesce(current_primary_line_id, 0))`).where(sql`status IN ('PENDING', 'MORE_INFO_REQUIRED') AND deleted_at IS NULL`),
  index("idx_hr_rm_requests_org_status").on(table.orgId, table.status, table.createdAt.desc(), table.id.desc()).where(sql`deleted_at IS NULL`),
  index("idx_hr_rm_requests_org_requester").on(table.orgId, table.requestedByUserId, table.createdAt.desc()).where(sql`deleted_at IS NULL`),
  index("idx_hr_rm_requests_employee").on(table.orgId, table.employeeEmploymentId),
  index("idx_hr_rm_requests_current_line").on(table.orgId, table.currentPrimaryLineId).where(sql`current_primary_line_id IS NOT NULL`),
  index("idx_hr_rm_requests_suggested_manager").on(table.orgId, table.suggestedManagerEmploymentId).where(sql`suggested_manager_employment_id IS NOT NULL`),
  index("idx_hr_rm_requests_resolved_line").on(table.orgId, table.resolvedLineId).where(sql`resolved_line_id IS NOT NULL`),
  check("chk_hr_rm_requests_status", sql`${table.status} IN ('PENDING', 'MORE_INFO_REQUIRED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')`),
  check("chk_hr_rm_requests_employee_reason", sql`char_length(btrim(${table.employeeReason})) BETWEEN 20 AND 1000`),
  check("chk_hr_rm_requests_review_reason", sql`${table.reviewReason} IS NULL OR char_length(${table.reviewReason}) <= 1000`),
]);

export const hrReportingLinesSuperseded = pgTable("hr_reporting_lines_superseded", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  lineId: integer("line_id").notNull(),
  employmentId: integer("employment_id").notNull(),
  managerEmploymentId: integer("manager_employment_id").notNull(),
  lineType: hrReportingLineTypeEnum("line_type").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull(),
  source: text("source").$type<ReportingLineSource>().notNull(),
  changeReason: text("change_reason"),
  relationshipLabel: text("relationship_label"),
  bulkJobId: uuid("bulk_job_id"),
  requestId: uuid("request_id"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull(),
  supersededReason: text("superseded_reason").$type<ReportingLineSupersededReason>().notNull(),
  supersededBy: text("superseded_by"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_rl_superseded_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rl_superseded_employment" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.managerEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_rl_superseded_manager" }).onDelete("cascade"),
  unique("uniq_hr_rl_superseded_org_line").on(table.orgId, table.lineId),
  index("idx_hr_rl_superseded_recent").on(table.orgId, table.employmentId, table.lineType, table.createdAt),
  index("idx_hr_rl_superseded_manager").on(table.orgId, table.managerEmploymentId),
  check("chk_hr_rl_superseded_reason", sql`${table.supersededReason} IN ('REPLACED', 'LEGACY_EMPTY_PERIOD')`),
]);

export const hrTopLevelRoles = pgTable("hr_top_level_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  employmentId: integer("employment_id").notNull(),
  reason: text("reason").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull().default(sql`'infinity'::date`),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  endedBy: text("ended_by"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.orgId], foreignColumns: [organizations.id], name: "fk_hr_top_level_roles_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_top_level_roles_employment" }).onDelete("cascade"),
  uniqueIndex("uniq_hr_top_level_roles_open").on(table.orgId, table.employmentId).where(sql`effective_to = 'infinity'::date`),
  index("idx_hr_top_level_roles_employment").on(table.orgId, table.employmentId, table.effectiveFrom),
  check("chk_hr_top_level_roles_reason", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 500`),
  check("chk_hr_top_level_roles_dates", sql`${table.effectiveFrom} <= ${table.effectiveTo}`),
]);
