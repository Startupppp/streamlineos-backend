import { boolean, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { hrEmployments } from "./core-people";

export const hrWorkAuthTypeEnum = pgEnum("hr_work_auth_type", [
  "work_permit",
  "visa",
  "right_to_work",
  "citizenship_proof",
  "other",
]);

export const hrWorkAuthStatusEnum = pgEnum("hr_work_auth_status", [
  "active",
  "expiring",
  "expired",
  "pending_renewal",
]);

export const hrComplianceCategoryEnum = pgEnum("hr_compliance_category", [
  "statutory_filing",
  "registration",
  "posting",
  "training",
  "audit",
  "other",
]);

export const hrComplianceFrequencyEnum = pgEnum("hr_compliance_frequency", [
  "once",
  "monthly",
  "quarterly",
  "yearly",
]);

export const hrComplianceEventStatusEnum = pgEnum("hr_compliance_event_status", [
  "pending",
  "done",
  "overdue",
]);

export const hrContractTypeEnum = pgEnum("hr_contract_type", [
  "contractor",
  "consultant",
  "intern",
  "temporary",
  "agency",
  "freelancer",
]);

export const hrContractStatusEnum = pgEnum("hr_contract_status", [
  "active",
  "expiring",
  "ended",
  "renewed",
  "converted",
]);

export const hrWorkAuthorizations = pgTable("hr_work_authorizations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  authType: hrWorkAuthTypeEnum("auth_type").notNull(),
  countryCode: text("country_code").notNull(),
  documentNumberMasked: text("document_number_masked"),
  validFrom: date("valid_from"),
  validUntil: date("valid_until"),
  status: hrWorkAuthStatusEnum("status").default("active").notNull(),
  verifiedBy: text("verified_by").references(() => users.id, { onDelete: "set null" }),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_work_authorizations_org_employment" }).onDelete("cascade"),
  unique("uniq_hr_work_authorizations_org_id").on(table.orgId, table.id),
  index("idx_hr_work_auths_org_emp").on(table.orgId, table.employmentId),
  index("idx_hr_work_auths_org_valid_until").on(table.orgId, table.validUntil),
  index("idx_hr_work_auths_org_status").on(table.orgId, table.status),
]);

export const hrComplianceRequirements = pgTable("hr_compliance_requirements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  countryCode: text("country_code"),
  stateCode: text("state_code"),
  category: hrComplianceCategoryEnum("category").notNull(),
  frequency: hrComplianceFrequencyEnum("frequency").notNull(),
  dueRule: jsonb("due_rule").$type<{ month?: number; day?: number; offsetDays?: number }>().notNull(),
  reminderDaysBefore: integer("reminder_days_before").default(7).notNull(),
  active: boolean("active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_compliance_requirements_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_compliance_req_org_name").on(table.orgId, table.name),
  index("idx_hr_compliance_req_org_country").on(table.orgId, table.countryCode),
  index("idx_hr_compliance_req_org_active").on(table.orgId, table.active),
]);

export const hrComplianceEvents = pgTable("hr_compliance_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  requirementId: integer("requirement_id").notNull(),
  dueDate: date("due_date").notNull(),
  status: hrComplianceEventStatusEnum("status").default("pending").notNull(),
  completedBy: text("completed_by").references(() => users.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.requirementId], foreignColumns: [hrComplianceRequirements.orgId, hrComplianceRequirements.id], name: "fk_hr_compliance_events_org_requirement" }).onDelete("cascade"),
  unique("uniq_hr_compliance_events_org_id").on(table.orgId, table.id),
  index("idx_hr_compliance_events_org_due").on(table.orgId, table.dueDate),
  index("idx_hr_compliance_events_org_status").on(table.orgId, table.status),
  index("idx_hr_compliance_events_req").on(table.requirementId),
]);

export const hrContracts = pgTable("hr_contracts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employmentId: integer("employment_id").notNull(),
  contractType: hrContractTypeEnum("contract_type").notNull(),
  agencyVendor: text("agency_vendor"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  renewalReminderDays: integer("renewal_reminder_days").default(30).notNull(),
  stipendCents: integer("stipend_cents"),
  timesheetBased: boolean("timesheet_based").default(false).notNull(),
  status: hrContractStatusEnum("status").default("active").notNull(),
  documentUrl: text("document_url"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_contracts_org_employment" }).onDelete("cascade"),
  unique("uniq_hr_contracts_org_id").on(table.orgId, table.id),
  index("idx_hr_contracts_org_end_date").on(table.orgId, table.endDate),
  index("idx_hr_contracts_org_status").on(table.orgId, table.status),
  index("idx_hr_contracts_org_emp").on(table.orgId, table.employmentId),
]);

export const hrWorkAuthorizationsRelations = relations(hrWorkAuthorizations, ({ one }) => ({
  org: one(organizations, { fields: [hrWorkAuthorizations.orgId], references: [organizations.id] }),
  employment: one(hrEmployments, { fields: [hrWorkAuthorizations.employmentId], references: [hrEmployments.id] }),
  verifier: one(users, { fields: [hrWorkAuthorizations.verifiedBy], references: [users.id] }),
}));

export const hrComplianceRequirementsRelations = relations(hrComplianceRequirements, ({ one, many }) => ({
  org: one(organizations, { fields: [hrComplianceRequirements.orgId], references: [organizations.id] }),
  events: many(hrComplianceEvents),
}));

export const hrComplianceEventsRelations = relations(hrComplianceEvents, ({ one }) => ({
  org: one(organizations, { fields: [hrComplianceEvents.orgId], references: [organizations.id] }),
  requirement: one(hrComplianceRequirements, { fields: [hrComplianceEvents.requirementId], references: [hrComplianceRequirements.id] }),
  completedByUser: one(users, { fields: [hrComplianceEvents.completedBy], references: [users.id] }),
}));

export const hrContractsRelations = relations(hrContracts, ({ one }) => ({
  org: one(organizations, { fields: [hrContracts.orgId], references: [organizations.id] }),
  employment: one(hrEmployments, { fields: [hrContracts.employmentId], references: [hrEmployments.id] }),
}));
