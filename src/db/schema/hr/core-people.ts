import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  date,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { organizations, organizationMembers, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { organizationPeople } from "../directory/organization-people";
import { workers } from "../directory/workers";

export const hrEmploymentLifecycleStatusEnum = pgEnum("hr_employment_lifecycle_status", [
  "CANDIDATE",
  "PRE_JOINING",
  "ONBOARDING",
  "ACTIVE",
  "PROBATION",
  "CONFIRMED",
  "NOTICE",
  "EXITED",
  "ALUMNI",
  "SUSPENDED",
]);

export const hrWorkerTypeEnum = pgEnum("hr_worker_type", [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACTOR",
  "CONSULTANT",
  "INTERN",
  "TEMPORARY",
  "AGENCY",
  "FREELANCER",
]);

export const hrEffectiveDateChangeTypeEnum = pgEnum("hr_effective_dated_change_type", [
  "department",
  "manager",
  "location",
  "designation",
  "job_level",
  "employment_type",
  "compensation",
  "work_schedule",
  "policy_assignment",
]);

export const hrEffectiveDateChangeStatusEnum = pgEnum("hr_effective_dated_change_status", [
  "draft",
  "approved",
  "applied",
]);

export const hrReportingLineTypeEnum = pgEnum("hr_reporting_line_type", [
  "primary",
  "matrix",
  "dotted",
]);

export const hrPeople = pgTable("hr_people", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  organizationPersonId: text("organization_person_id"),
  rowVersion: integer("row_version").default(1).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByMembershipId: integer("archived_by_membership_id"),
  updatedByMembershipId: integer("updated_by_membership_id"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_people_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_people_org_person_link")
    .on(table.orgId, table.organizationPersonId)
    .where(sql`${table.organizationPersonId} IS NOT NULL`),
  index("idx_hr_people_org").on(table.orgId),
  index("idx_hr_people_org_live").on(table.orgId).where(sql`${table.deletedAt} IS NULL`),
  index("idx_hr_people_user").on(table.userId),
  index("idx_hr_people_updated_actor").on(table.orgId, table.updatedByMembershipId),
  index("idx_hr_people_archived_actor").on(table.orgId, table.archivedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.organizationPersonId],
    foreignColumns: [
      organizationPeople.organizationId,
      organizationPeople.organizationPersonId,
    ],
    name: "fk_hr_people_org_person",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_people_updated_actor",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.archivedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_people_archived_actor",
  }).onDelete("restrict"),
  check("chk_hr_people_row_version", sql`${table.rowVersion} > 0`),
]);

export const hrEmployments = pgTable("hr_employments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  personId: integer("person_id").notNull(),
  workerId: text("worker_id"),
  workerEngagementId: text("worker_engagement_id"),
  employeeNumber: text("employee_number").notNull(),
  lifecycleStatus: hrEmploymentLifecycleStatusEnum("lifecycle_status").default("ACTIVE").notNull(),
  workerType: hrWorkerTypeEnum("worker_type").default("FULL_TIME").notNull(),
  departmentId: text("department_id"),
  jobRoleId: integer("job_role_id"),
  jobLevelId: integer("job_level_id"),
  employmentTypeId: integer("employment_type_id"),
  locationId: text("location_id"),
  designation: text("designation"),
  joiningDate: date("joining_date"),
  probationEndDate: date("probation_end_date"),
  confirmationDate: date("confirmation_date"),
  noticeStartDate: date("notice_start_date"),
  expectedLastDay: date("expected_last_day"),
  lastWorkingDay: date("last_working_day"),
  exitDate: date("exit_date"),
  exitReason: text("exit_reason"),
  customFieldValues: jsonb("custom_field_values")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  isPrimary: boolean("is_primary").default(true).notNull(),
  rowVersion: integer("row_version").default(1).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByMembershipId: integer("archived_by_membership_id"),
  updatedByMembershipId: integer("updated_by_membership_id"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.departmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_hr_employments_org_department" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.locationId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_hr_employments_org_location" }).onDelete("set null"),
  unique("uniq_hr_employments_org_id").on(table.orgId, table.id),
  unique("uniq_hr_employments_org_id_person").on(
    table.orgId,
    table.id,
    table.personId,
  ),
  uniqueIndex("uniq_hr_employments_org_emp_num").on(table.orgId, table.employeeNumber),
  uniqueIndex("uniq_hr_employments_org_engagement_link")
    .on(table.orgId, table.workerEngagementId)
    .where(sql`${table.workerEngagementId} IS NOT NULL`),
  index("idx_hr_employments_org").on(table.orgId),
  index("idx_hr_employments_person").on(table.personId),
  index("idx_hr_employments_org_person").on(table.orgId, table.personId),
  index("idx_hr_employments_worker").on(table.orgId, table.workerId),
  index("idx_hr_employments_org_status").on(table.orgId, table.lifecycleStatus),
  index("idx_hr_employments_org_live_status")
    .on(table.orgId, table.lifecycleStatus)
    .where(sql`${table.deletedAt} IS NULL`),
  index("idx_hr_employments_dept").on(table.departmentId),
  index("idx_hr_employments_updated_actor").on(
    table.orgId,
    table.updatedByMembershipId,
  ),
  index("idx_hr_employments_archived_actor").on(
    table.orgId,
    table.archivedByMembershipId,
  ),
  foreignKey({
    columns: [table.orgId, table.personId],
    foreignColumns: [hrPeople.orgId, hrPeople.id],
    name: "fk_hr_employments_org_person",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_hr_employments_org_worker",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_employments_updated_actor",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.archivedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_employments_archived_actor",
  }).onDelete("restrict"),
  check(
    "chk_hr_employments_canonical_link",
    sql`(${table.workerId} IS NULL) = (${table.workerEngagementId} IS NULL)`,
  ),
  check("chk_hr_employments_row_version", sql`${table.rowVersion} > 0`),
]);

export const hrEmployeeSensitiveFields = pgTable("hr_employee_sensitive_fields", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  salaryAmountCents: integer("salary_amount_cents"),
  salaryCurrency: text("salary_currency").default("INR"),
  salaryFrequency: text("salary_frequency").default("MONTHLY"),
  bankDetails: text("bank_details"),
  encryptionKeyRef: text("encryption_key_ref"),
  taxId: text("tax_id"),
  panNumber: text("pan_number"),
  nationalId: text("national_id"),
  passportNumber: text("passport_number"),
  passportExpiry: date("passport_expiry"),
  visaType: text("visa_type"),
  visaExpiry: date("visa_expiry"),
  medicalNotes: text("medical_notes"),
  bloodGroup: text("blood_group"),
  disciplinaryRecords: jsonb("disciplinary_records").$type<Array<Record<string, unknown>>>(),
  grievanceRecords: jsonb("grievance_records").$type<Array<Record<string, unknown>>>(),
  bgvStatus: text("bgv_status"),
  bgvCompletedAt: timestamp("bgv_completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_employee_sensitive_fields_org_employment" }).onDelete("cascade"),
  unique("uniq_hr_employee_sensitive_fields_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_sensitive_employment").on(table.employmentId),
  index("idx_hr_sensitive_org").on(table.orgId),
]);

export const hrEmploymentHistory = pgTable("hr_employment_history", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  fromStatus: hrEmploymentLifecycleStatusEnum("from_status").notNull(),
  toStatus: hrEmploymentLifecycleStatusEnum("to_status").notNull(),
  reason: text("reason"),
  notes: text("notes"),
  effectiveDate: date("effective_date"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_employment_history_org_employment" }).onDelete("cascade"),
  unique("uniq_hr_employment_history_org_id").on(table.orgId, table.id),
  index("idx_hr_emp_history_org_employment").on(table.orgId, table.employmentId),
  index("idx_hr_emp_history_created_at").on(table.createdAt),
  index("idx_hr_emp_history_created_actor").on(table.orgId, table.createdByMembershipId),
  foreignKey({
    name: "fk_hr_emp_history_created_actor",
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);

export const OPEN_ENDED_DATE = "infinity";

export const hrEffectiveDatedChanges = pgTable("hr_effective_dated_changes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  changeType: hrEffectiveDateChangeTypeEnum("change_type").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to")
    .notNull()
    .default(sql`'infinity'::date`),
  status: hrEffectiveDateChangeStatusEnum("status").default("draft").notNull(),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  appliedAt: timestamp("applied_at"),
  notes: text("notes"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_effective_dated_changes_org_employment" }).onDelete("cascade"),
  unique("uniq_hr_effective_dated_changes_org_id").on(table.orgId, table.id),
  index("idx_hr_eff_changes_org_employment").on(table.orgId, table.employmentId),
  index("idx_hr_eff_changes_org_status").on(table.orgId, table.status),
  index("idx_hr_eff_changes_effective_from").on(table.effectiveFrom),
  index("idx_hr_eff_changes_type").on(table.changeType),
  index("idx_hr_eff_changes_created_actor").on(table.orgId, table.createdByMembershipId),
  index("idx_hr_eff_changes_approved_actor").on(table.orgId, table.approvedByMembershipId),
  foreignKey({
    name: "fk_hr_eff_changes_created_actor",
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
  foreignKey({
    name: "fk_hr_eff_changes_approved_actor",
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);

export const hrReportingLines = pgTable("hr_reporting_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  managerEmploymentId: integer("manager_employment_id").notNull(),
  lineType: hrReportingLineTypeEnum("line_type").default("primary").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to")
    .notNull()
    .default(sql`'infinity'::date`),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_reporting_lines_org_employment" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.managerEmploymentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_reporting_lines_org_manager_employment" }).onDelete("cascade"),
  unique("uniq_hr_reporting_lines_org_id").on(table.orgId, table.id),
  index("idx_hr_reporting_lines_org_emp").on(table.orgId, table.employmentId),
  index("idx_hr_reporting_lines_manager").on(table.managerEmploymentId),
  index("idx_hr_reporting_lines_org_type").on(table.orgId, table.lineType),
]);

export const hrPeopleRelations = relations(hrPeople, ({ one, many }) => ({
  org: one(organizations, { fields: [hrPeople.orgId], references: [organizations.id] }),
  user: one(users, { fields: [hrPeople.userId], references: [users.id] }),
  canonicalPerson: one(organizationPeople, {
    fields: [hrPeople.organizationPersonId],
    references: [organizationPeople.organizationPersonId],
  }),
  employments: many(hrEmployments),
}));

export const hrEmploymentsRelations = relations(hrEmployments, ({ one, many }) => ({
  org: one(organizations, { fields: [hrEmployments.orgId], references: [organizations.id] }),
  person: one(hrPeople, { fields: [hrEmployments.personId], references: [hrPeople.id] }),
  canonicalWorker: one(workers, {
    fields: [hrEmployments.workerId],
    references: [workers.workerId],
  }),
  department: one(orgUnits, { fields: [hrEmployments.departmentId], references: [orgUnits.id] }),
  location: one(orgUnits, { fields: [hrEmployments.locationId], references: [orgUnits.id] }),
  sensitiveFields: one(hrEmployeeSensitiveFields, { fields: [hrEmployments.id], references: [hrEmployeeSensitiveFields.employmentId] }),
  history: many(hrEmploymentHistory),
  effectiveDatedChanges: many(hrEffectiveDatedChanges),
  reportingLines: many(hrReportingLines, { relationName: "reportee_lines" }),
  managedLines: many(hrReportingLines, { relationName: "manager_lines" }),
}));

