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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";

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
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  workEmail: text("work_email").notNull(),
  personalEmail: text("personal_email"),
  phone: text("phone"),
  dateOfBirth: date("date_of_birth"),
  gender: text("gender"),
  nationality: text("nationality"),
  address: jsonb("address").$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
  }>(),
  emergencyContact: jsonb("emergency_contact").$type<{
    name?: string;
    relationship?: string;
    phone?: string;
  }>(),
  avatarUrl: text("avatar_url"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_people_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_people_org_work_email").on(table.orgId, table.workEmail),
  index("idx_hr_people_org").on(table.orgId),
  index("idx_hr_people_user").on(table.userId),
]);

export const hrEmployments = pgTable("hr_employments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  personId: integer("person_id").references(() => hrPeople.id, { onDelete: "cascade" }).notNull(),
  employeeNumber: text("employee_number").notNull(),
  lifecycleStatus: hrEmploymentLifecycleStatusEnum("lifecycle_status").default("ACTIVE").notNull(),
  workerType: hrWorkerTypeEnum("worker_type").default("FULL_TIME").notNull(),
  departmentId: text("department_id").references(() => orgUnits.id, { onDelete: "set null" }),
  jobRoleId: integer("job_role_id"),
  jobLevelId: integer("job_level_id"),
  employmentTypeId: integer("employment_type_id"),
  locationId: text("location_id").references(() => orgUnits.id, { onDelete: "set null" }),
  designation: text("designation"),
  joiningDate: date("joining_date"),
  probationEndDate: date("probation_end_date"),
  confirmationDate: date("confirmation_date"),
  noticeStartDate: date("notice_start_date"),
  expectedLastDay: date("expected_last_day"),
  lastWorkingDay: date("last_working_day"),
  exitDate: date("exit_date"),
  exitReason: text("exit_reason"),
  isPrimary: boolean("is_primary").default(true).notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_employments_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_employments_org_emp_num").on(table.orgId, table.employeeNumber),
  index("idx_hr_employments_org").on(table.orgId),
  index("idx_hr_employments_person").on(table.personId),
  index("idx_hr_employments_org_status").on(table.orgId, table.lifecycleStatus),
  index("idx_hr_employments_dept").on(table.departmentId),
]);

export const hrEmployeeSensitiveFields = pgTable("hr_employee_sensitive_fields", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").references(() => hrEmployments.id, { onDelete: "cascade" }).notNull(),
  salaryAmountCents: integer("salary_amount_cents"),
  salaryCurrency: text("salary_currency").default("INR"),
  salaryFrequency: text("salary_frequency").default("MONTHLY"),
  bankDetails: jsonb("bank_details").$type<{
    accountNumber?: string;
    bankName?: string;
    branch?: string;
    ifsc?: string;
    swift?: string;
    accountHolder?: string;
    pfUanNumber?: string;
    esiIpNumber?: string;
    iban?: string;
    routingNumber?: string;
  }>(),
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
  unique("uniq_hr_employee_sensitive_fields_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_sensitive_employment").on(table.employmentId),
  index("idx_hr_sensitive_org").on(table.orgId),
]);

export const hrEmploymentHistory = pgTable("hr_employment_history", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").references(() => hrEmployments.id, { onDelete: "cascade" }).notNull(),
  fromStatus: hrEmploymentLifecycleStatusEnum("from_status").notNull(),
  toStatus: hrEmploymentLifecycleStatusEnum("to_status").notNull(),
  reason: text("reason"),
  notes: text("notes"),
  effectiveDate: date("effective_date"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_employment_history_org_id").on(table.orgId, table.id),
  index("idx_hr_emp_history_org_employment").on(table.orgId, table.employmentId),
  index("idx_hr_emp_history_created_at").on(table.createdAt),
]);

export const hrEffectiveDatedChanges = pgTable("hr_effective_dated_changes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").references(() => hrEmployments.id, { onDelete: "cascade" }).notNull(),
  changeType: hrEffectiveDateChangeTypeEnum("change_type").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  status: hrEffectiveDateChangeStatusEnum("status").default("draft").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  appliedAt: timestamp("applied_at"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_effective_dated_changes_org_id").on(table.orgId, table.id),
  index("idx_hr_eff_changes_org_employment").on(table.orgId, table.employmentId),
  index("idx_hr_eff_changes_org_status").on(table.orgId, table.status),
  index("idx_hr_eff_changes_effective_from").on(table.effectiveFrom),
  index("idx_hr_eff_changes_type").on(table.changeType),
]);

export const hrReportingLines = pgTable("hr_reporting_lines", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").references(() => hrEmployments.id, { onDelete: "cascade" }).notNull(),
  managerEmploymentId: integer("manager_employment_id").references(() => hrEmployments.id, { onDelete: "cascade" }).notNull(),
  lineType: hrReportingLineTypeEnum("line_type").default("primary").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_reporting_lines_org_id").on(table.orgId, table.id),
  index("idx_hr_reporting_lines_org_emp").on(table.orgId, table.employmentId),
  index("idx_hr_reporting_lines_manager").on(table.managerEmploymentId),
  index("idx_hr_reporting_lines_org_type").on(table.orgId, table.lineType),
]);

export const hrPeopleRelations = relations(hrPeople, ({ one, many }) => ({
  org: one(organizations, { fields: [hrPeople.orgId], references: [organizations.id] }),
  user: one(users, { fields: [hrPeople.userId], references: [users.id] }),
  employments: many(hrEmployments),
}));

export const hrEmploymentsRelations = relations(hrEmployments, ({ one, many }) => ({
  org: one(organizations, { fields: [hrEmployments.orgId], references: [organizations.id] }),
  person: one(hrPeople, { fields: [hrEmployments.personId], references: [hrPeople.id] }),
  department: one(orgUnits, { fields: [hrEmployments.departmentId], references: [orgUnits.id] }),
  location: one(orgUnits, { fields: [hrEmployments.locationId], references: [orgUnits.id] }),
  sensitiveFields: one(hrEmployeeSensitiveFields, { fields: [hrEmployments.id], references: [hrEmployeeSensitiveFields.employmentId] }),
  history: many(hrEmploymentHistory),
  effectiveDatedChanges: many(hrEffectiveDatedChanges),
  reportingLines: many(hrReportingLines, { relationName: "reportee_lines" }),
  managedLines: many(hrReportingLines, { relationName: "manager_lines" }),
}));

