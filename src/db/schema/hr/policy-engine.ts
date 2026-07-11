import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  jsonb,
  date,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrPolicyTypeEnum = pgEnum("hr_policy_type", [
  "leave",
  "attendance",
  "shift_roster",
  "overtime",
  "comp_off",
  "probation",
  "notice_period",
  "document_requirement",
  "approval",
  "expense",
  "travel",
  "asset",
  "wfh",
  "remote_work",
  "payroll_eligibility",
]);

export const hrPolicyStatusEnum = pgEnum("hr_policy_status", [
  "draft",
  "active",
  "archived",
]);

export const hrPolicyScopeTypeEnum = pgEnum("hr_policy_scope_type", [
  "organization",
  "country",
  "state",
  "location",
  "department",
  "team",
  "role",
  "job_level",
  "employment_type",
  "employee",
]);

export const hrPolicies = pgTable(
  "hr_policies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    policyType: hrPolicyTypeEnum("policy_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: hrPolicyStatusEnum("status").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    parentPolicyId: integer("parent_policy_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").default(0).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    uniqueIndex("uniq_hr_policies_org_type_name_version").on(
      table.orgId,
      table.policyType,
      table.name,
      table.version,
    ),
    index("idx_hr_policies_org_type_status").on(
      table.orgId,
      table.policyType,
      table.status,
    ),
    index("idx_hr_policies_org_status").on(table.orgId, table.status),
  ],
);

export const hrPolicyScopes = pgTable(
  "hr_policy_scopes",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    policyId: integer("policy_id")
      .references(() => hrPolicies.id, { onDelete: "cascade" })
      .notNull(),
    scopeType: hrPolicyScopeTypeEnum("scope_type").notNull(),
    scopeValue: text("scope_value").notNull(),
  },
  (table) => [
    index("idx_hr_policy_scopes_org_policy").on(table.orgId, table.policyId),
    index("idx_hr_policy_scopes_org_type_value").on(
      table.orgId,
      table.scopeType,
      table.scopeValue,
    ),
  ],
);

export const hrPolicyAssignments = pgTable(
  "hr_policy_assignments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    policyId: integer("policy_id")
      .references(() => hrPolicies.id, { onDelete: "cascade" })
      .notNull(),
    employeeId: text("employee_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_hr_policy_assignments_org_policy").on(
      table.orgId,
      table.policyId,
    ),
    index("idx_hr_policy_assignments_org_employee").on(
      table.orgId,
      table.employeeId,
    ),
  ],
);

export const hrPoliciesRelations = relations(hrPolicies, ({ many }) => ({
  scopes: many(hrPolicyScopes),
  assignments: many(hrPolicyAssignments),
}));

export const hrPolicyScopesRelations = relations(hrPolicyScopes, ({ one }) => ({
  policy: one(hrPolicies, {
    fields: [hrPolicyScopes.policyId],
    references: [hrPolicies.id],
  }),
}));

export const hrPolicyAssignmentsRelations = relations(
  hrPolicyAssignments,
  ({ one }) => ({
    policy: one(hrPolicies, {
      fields: [hrPolicyAssignments.policyId],
      references: [hrPolicies.id],
    }),
  }),
);
