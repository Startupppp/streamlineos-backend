import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { hrJobLevels } from "./core-org";

export const hrLegalHoldStatusEnum = pgEnum("hr_legal_hold_status", ["active", "released"]);

export const hrLegalHoldItemTypeEnum = pgEnum("hr_legal_hold_item_type", [
  "employee_profile",
  "document",
  "case_evidence",
]);

export const hrRetentionRecordTypeEnum = pgEnum("hr_retention_record_type", [
  "employee",
  "document",
  "case",
  "attendance",
  "payroll",
]);

export const hrRetentionActionEnum = pgEnum("hr_retention_action", ["delete", "anonymize"]);

export const hrDataRequestTypeEnum = pgEnum("hr_data_request_type", [
  "export",
  "delete",
  "anonymize",
  "correction",
]);

export const hrDataRequestStatusEnum = pgEnum("hr_data_request_status", [
  "pending",
  "approved",
  "processing",
  "completed",
  "rejected",
  "partial",
]);

export const hrProxyScopeEnum = pgEnum("hr_proxy_scope", ["approvals", "hr_admin", "manager_tasks"]);

export const hrPositionStatusEnum = pgEnum("hr_position_status", ["open", "filled", "frozen", "future"]);

export const hrReorgScenarioStatusEnum = pgEnum("hr_reorg_scenario_status", ["draft", "proposed", "applied"]);

export const hrUnionMembershipStatusEnum = pgEnum("hr_union_membership_status", ["active", "inactive"]);

export const hrCollectiveAgreementStatusEnum = pgEnum("hr_collective_agreement_status", [
  "active",
  "expired",
  "negotiating",
]);

export const hrLaborCaseStatusEnum = pgEnum("hr_labor_case_status", ["open", "in_review", "resolved"]);

export const hrLegalHolds = pgTable(
  "hr_legal_holds",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id"),
    subjectMembershipId: integer("subject_membership_id"),
    reason: text("reason").notNull(),
    status: hrLegalHoldStatusEnum("status").notNull().default("active"),
    placedBy: text("placed_by").references(() => users.id, { onDelete: "set null" }),
    placedAt: timestamp("placed_at").notNull().defaultNow(),
    releasedBy: text("released_by").references(() => users.id, { onDelete: "set null" }),
    releasedAt: timestamp("released_at"),
    restrictedExport: boolean("restricted_export").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_legal_holds_org_id").on(table.orgId, table.id),
    index("idx_hr_legal_holds_org_status").on(table.orgId, table.status),
    index("idx_hr_legal_holds_org_subject").on(table.orgId, table.subjectUserId),
  ],
);

export const hrLegalHoldItems = pgTable(
  "hr_legal_hold_items",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    holdId: integer("hold_id")
      .notNull()
      ,
    itemType: hrLegalHoldItemTypeEnum("item_type").notNull(),
    itemRef: text("item_ref").notNull(),
    locked: boolean("locked").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.holdId], foreignColumns: [hrLegalHolds.orgId, hrLegalHolds.id], name: "fk_hr_legal_hold_items_org_hold" }).onDelete("cascade"),
    unique("uniq_hr_legal_hold_items_org_id").on(table.orgId, table.id),
    index("idx_hr_legal_hold_items_hold").on(table.holdId),
    index("idx_hr_legal_hold_items_org_subject").on(table.orgId, table.itemType, table.itemRef),
  ],
);

export const hrRetentionPolicies = pgTable(
  "hr_retention_policies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recordType: hrRetentionRecordTypeEnum("record_type").notNull(),
    retentionMonths: integer("retention_months").notNull(),
    countryCode: text("country_code"),
    action: hrRetentionActionEnum("action").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_retention_policies_org_id").on(table.orgId, table.id),
    index("idx_hr_retention_policies_org").on(table.orgId),
    uniqueIndex("uniq_hr_retention_policy_org_type_country").on(
      table.orgId,
      table.recordType,
      table.countryCode,
    ),
  ],
);

export const hrDataRequests = pgTable(
  "hr_data_requests",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id")
      .notNull()
      ,
    subjectMembershipId: integer("subject_membership_id"),
    type: hrDataRequestTypeEnum("type").notNull(),
    status: hrDataRequestStatusEnum("status").notNull().default("pending"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    completedAt: timestamp("completed_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_data_requests_org_id").on(table.orgId, table.id),
    index("idx_hr_data_requests_org_status").on(table.orgId, table.status),
    index("idx_hr_data_requests_org_subject").on(table.orgId, table.subjectUserId),
  ],
);

export const hrProxyAccess = pgTable(
  "hr_proxy_access",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantorUserId: text("grantor_user_id")
      .notNull()
      ,
    grantorMembershipId: integer("grantor_membership_id"),
    proxyUserId: text("proxy_user_id")
      .notNull()
      ,
    proxyMembershipId: integer("proxy_membership_id"),
    scope: hrProxyScopeEnum("scope").notNull(),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    reason: text("reason"),
    active: boolean("active").notNull().default(true),
    disallowSensitive: boolean("disallow_sensitive").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_proxy_access_org_id").on(table.orgId, table.id),
    index("idx_hr_proxy_access_org_grantor").on(table.orgId, table.grantorUserId),
    index("idx_hr_proxy_access_org_proxy").on(table.orgId, table.proxyUserId),
    index("idx_hr_proxy_access_org_grantor_membership").on(table.orgId, table.grantorMembershipId),
    index("idx_hr_proxy_access_org_proxy_membership").on(table.orgId, table.proxyMembershipId),
    foreignKey({
      columns: [table.orgId, table.grantorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_proxy_access_grantor_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.proxyMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_proxy_access_proxy_actor",
    }).onDelete("set null"),
  ],
);

export const hrPositions = pgTable(
  "hr_positions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    departmentId: text("department_id"),
    jobLevelId: integer("job_level_id"),
    status: text("status").notNull().default("open"),
    budgetedCostCents: integer("budgeted_cost_cents"),
    effectiveFrom: timestamp("effective_from").notNull(),
    incumbentUserId: text("incumbent_user_id").references(() => users.id, { onDelete: "set null" }),
    futureDated: boolean("future_dated").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.departmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_hr_positions_org_department" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.jobLevelId], foreignColumns: [hrJobLevels.orgId, hrJobLevels.id], name: "fk_hr_positions_job_level_id_org" }).onDelete("set null"),
    unique("uniq_hr_positions_org_id").on(table.orgId, table.id),
    index("idx_hr_positions_org_status").on(table.orgId, table.status),
    index("idx_hr_positions_org_dept").on(table.orgId, table.departmentId),
    index("idx_hr_positions_org").on(table.orgId),
  ],
);

export const hrReorgScenarios = pgTable(
  "hr_reorg_scenarios",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: hrReorgScenarioStatusEnum("status").notNull().default("draft"),
    changes: jsonb("changes").notNull().$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_reorg_scenarios_org_id").on(table.orgId, table.id),
    index("idx_hr_reorg_scenarios_org_status").on(table.orgId, table.status),
  ],
);

export const hrUnionMemberships = pgTable(
  "hr_union_memberships",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      ,
    userMembershipId: integer("user_membership_id"),
    unionName: text("union_name").notNull(),
    memberSince: timestamp("member_since").notNull(),
    status: hrUnionMembershipStatusEnum("status").notNull().default("active"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_union_memberships_org_id").on(table.orgId, table.id),
    index("idx_hr_union_memberships_org").on(table.orgId),
    index("idx_hr_union_memberships_org_user").on(table.orgId, table.userId),
  ],
);

export const hrCollectiveAgreements = pgTable(
  "hr_collective_agreements",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    unionName: text("union_name").notNull(),
    title: text("title").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    expiresAt: timestamp("expires_at"),
    documentUrl: text("document_url"),
    status: hrCollectiveAgreementStatusEnum("status").notNull().default("active"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_collective_agreements_org_id").on(table.orgId, table.id),
    index("idx_hr_collective_agreements_org_status").on(table.orgId, table.status),
    index("idx_hr_collective_agreements_org_union").on(table.orgId, table.unionName),
  ],
);

export const hrLaborCases = pgTable(
  "hr_labor_cases",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    unionName: text("union_name").notNull(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    status: hrLaborCaseStatusEnum("status").notNull().default("open"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_labor_cases_org_id").on(table.orgId, table.id),
    index("idx_hr_labor_cases_org_status").on(table.orgId, table.status),
    index("idx_hr_labor_cases_org_union").on(table.orgId, table.unionName),
  ],
);

export const hrLegalHoldsRelations = relations(hrLegalHolds, ({ one, many }) => ({
  org: one(organizations, { fields: [hrLegalHolds.orgId], references: [organizations.id] }),
  subject: one(users, { fields: [hrLegalHolds.subjectUserId], references: [users.id], relationName: "hold_subject" }),
  placedByUser: one(users, { fields: [hrLegalHolds.placedBy], references: [users.id], relationName: "hold_placed_by" }),
  releasedByUser: one(users, { fields: [hrLegalHolds.releasedBy], references: [users.id], relationName: "hold_released_by" }),
  items: many(hrLegalHoldItems),
}));

export const hrLegalHoldItemsRelations = relations(hrLegalHoldItems, ({ one }) => ({
  hold: one(hrLegalHolds, { fields: [hrLegalHoldItems.holdId], references: [hrLegalHolds.id] }),
}));

export const hrRetentionPoliciesRelations = relations(hrRetentionPolicies, ({ one }) => ({
  org: one(organizations, { fields: [hrRetentionPolicies.orgId], references: [organizations.id] }),
}));

export const hrDataRequestsRelations = relations(hrDataRequests, ({ one }) => ({
  org: one(organizations, { fields: [hrDataRequests.orgId], references: [organizations.id] }),
  subject: one(users, { fields: [hrDataRequests.subjectUserId], references: [users.id], relationName: "request_subject" }),
  requestedByUser: one(users, { fields: [hrDataRequests.requestedBy], references: [users.id], relationName: "request_requester" }),
  approvedByUser: one(users, { fields: [hrDataRequests.approvedBy], references: [users.id], relationName: "request_approver" }),
}));

export const hrProxyAccessRelations = relations(hrProxyAccess, ({ one }) => ({
  org: one(organizations, { fields: [hrProxyAccess.orgId], references: [organizations.id] }),
  grantor: one(users, { fields: [hrProxyAccess.grantorUserId], references: [users.id], relationName: "proxy_grantor" }),
  proxy: one(users, { fields: [hrProxyAccess.proxyUserId], references: [users.id], relationName: "proxy_delegate" }),
}));

export const hrPositionsRelations = relations(hrPositions, ({ one }) => ({
  org: one(organizations, { fields: [hrPositions.orgId], references: [organizations.id] }),
  department: one(orgUnits, { fields: [hrPositions.departmentId], references: [orgUnits.id] }),
  incumbent: one(users, { fields: [hrPositions.incumbentUserId], references: [users.id] }),
}));

export const hrReorgScenariosRelations = relations(hrReorgScenarios, ({ one }) => ({
  org: one(organizations, { fields: [hrReorgScenarios.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [hrReorgScenarios.createdBy], references: [users.id] }),
}));

export const hrUnionMembershipsRelations = relations(hrUnionMemberships, ({ one }) => ({
  org: one(organizations, { fields: [hrUnionMemberships.orgId], references: [organizations.id] }),
  user: one(users, { fields: [hrUnionMemberships.userId], references: [users.id] }),
}));

export const hrCollectiveAgreementsRelations = relations(hrCollectiveAgreements, ({ one }) => ({
  org: one(organizations, { fields: [hrCollectiveAgreements.orgId], references: [organizations.id] }),
}));

export const hrLaborCasesRelations = relations(hrLaborCases, ({ one }) => ({
  org: one(organizations, { fields: [hrLaborCases.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [hrLaborCases.createdBy], references: [users.id] }),
}));
