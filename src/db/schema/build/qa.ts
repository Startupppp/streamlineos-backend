import {
  pgEnum,
  text,
  timestamp,
  integer,
  index,
  unique,
  uniqueIndex,
  jsonb,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects, sprints } from "./core";
import { tickets, projectReleases } from "./tasks";

export const testCasePriorityEnum = pgEnum("test_case_priority", ["low", "medium", "high"]);
export const testCaseAutomationStatusEnum = pgEnum("test_case_automation_status", ["manual", "automated", "planned"]);
export const testRunStatusEnum = pgEnum("test_run_status", ["not_started", "in_progress", "completed", "aborted"]);
export const testResultStatusEnum = pgEnum("test_result_status", ["not_run", "passed", "failed", "blocked", "skipped"]);

export const testSuites = build.table("test_suites", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: integer("parent_id").references((): AnyPgColumn => testSuites.id, { onDelete: "set null" }),
  position: integer("position").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_test_suites_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.parentId], foreignColumns: [table.orgId, table.id], name: "fk_test_suites_org_parent" }).onDelete("set null"),
  index("idx_test_suites_org_project").on(table.orgId, table.projectId).where(sql`deleted_at IS NULL`),
  index("idx_test_suites_parent").on(table.parentId),
  unique("uniq_test_suites_org_id").on(table.orgId, table.id),
]);

export const testCases = build.table("test_cases", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  suiteId: integer("suite_id"),
  caseNumber: integer("case_number").notNull(),
  title: text("title").notNull(),
  preconditions: text("preconditions"),
  steps: jsonb("steps").$type<{ action: string; expected: string }[]>().default(sql`'[]'::jsonb`),
  expectedResult: text("expected_result"),
  priority: testCasePriorityEnum("priority").default("medium").notNull(),
  component: text("component"),
  linkedTicketId: integer("linked_ticket_id"),
  automationStatus: testCaseAutomationStatusEnum("automation_status").default("manual").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_test_cases_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.suiteId], foreignColumns: [testSuites.orgId, testSuites.id], name: "fk_test_cases_org_suite" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_test_cases_org_ticket" }).onDelete("set null"),
  index("idx_test_cases_org_project_suite").on(table.orgId, table.projectId, table.suiteId).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_test_cases_project_number").on(table.projectId, table.caseNumber),
  unique("uniq_test_cases_org_id").on(table.orgId, table.id),
]);

export const testRuns = build.table("test_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  runNumber: integer("run_number").notNull(),
  name: text("name").notNull(),
  sprintId: integer("sprint_id"),
  releaseId: integer("release_id"),
  environment: text("environment"),
  browserDevice: text("browser_device"),
  testerId: text("tester_id").references(() => users.id, { onDelete: "set null" }),
  testerMembershipId: integer("tester_membership_id"),
  status: testRunStatusEnum("status").default("not_started").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.releaseId], foreignColumns: [projectReleases.orgId, projectReleases.id], name: "fk_test_runs_org_release" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_test_runs_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.sprintId], foreignColumns: [sprints.orgId, sprints.id], name: "fk_test_runs_org_sprint" }).onDelete("set null"),
  index("idx_test_runs_org_project_status").on(table.orgId, table.projectId, table.status).where(sql`deleted_at IS NULL`),
  index("idx_test_runs_sprint").on(table.sprintId),
  index("idx_test_runs_release").on(table.releaseId),
  index("idx_test_runs_org_tester_membership").on(table.orgId, table.testerMembershipId),
  uniqueIndex("uq_test_runs_project_number").on(table.projectId, table.runNumber),
  unique("uniq_test_runs_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_test_runs_tester_actor",
    columns: [table.orgId, table.testerMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);

export const testRunResults = build.table("test_run_results", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  runId: integer("run_id").notNull(),
  testCaseId: integer("test_case_id").notNull(),
  status: testResultStatusEnum("status").default("not_run").notNull(),
  notes: text("notes"),
  executedBy: text("executed_by").references(() => users.id, { onDelete: "set null" }),
  executedAt: timestamp("executed_at"),
  linkedBugId: integer("linked_bug_id").references((): AnyPgColumn => bugs.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.linkedBugId], foreignColumns: [bugs.orgId, bugs.id], name: "fk_test_run_results_org_bug" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_test_run_results_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.testCaseId], foreignColumns: [testCases.orgId, testCases.id], name: "fk_test_run_results_org_case" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [testRuns.orgId, testRuns.id], name: "fk_test_run_results_org_run" }).onDelete("cascade"),
  uniqueIndex("uq_test_run_results_run_case").on(table.runId, table.testCaseId),
  index("idx_test_run_results_org_project").on(table.orgId, table.projectId),
  unique("uniq_test_run_results_org_id").on(table.orgId, table.id),
]);

export const bugSeverityEnum = pgEnum("bug_severity", ["blocker", "critical", "major", "minor", "trivial"]);
export const bugPriorityEnum = pgEnum("bug_priority", ["low", "medium", "high", "urgent"]);
export const bugStatusEnum = pgEnum("bug_status", ["new", "triaged", "assigned", "in_progress", "fixed", "ready_for_qa", "verified", "reopened", "closed"]);

export const bugs = build.table("bugs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  bugNumber: integer("bug_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  severity: bugSeverityEnum("severity").default("major").notNull(),
  priority: bugPriorityEnum("priority").default("medium").notNull(),
  status: bugStatusEnum("status").default("new").notNull(),
  stepsToReproduce: text("steps_to_reproduce"),
  expectedResult: text("expected_result"),
  actualResult: text("actual_result"),
  environment: text("environment"),
  browserDevice: text("browser_device"),
  affectedReleaseId: integer("affected_release_id"),
  fixedReleaseId: integer("fixed_release_id"),
  assigneeMembershipId: integer("assignee_membership_id"),
  reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
  qaOwnerId: text("qa_owner_id").references(() => users.id, { onDelete: "set null" }),
  qaOwnerMembershipId: integer("qa_owner_membership_id"),
  reopenCount: integer("reopen_count").default(0).notNull(),
  linkedTicketId: integer("linked_ticket_id"),
  linkedTestCaseId: integer("linked_test_case_id").references((): AnyPgColumn => testCases.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.affectedReleaseId], foreignColumns: [projectReleases.orgId, projectReleases.id], name: "fk_bugs_org_affected_release" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.fixedReleaseId], foreignColumns: [projectReleases.orgId, projectReleases.id], name: "fk_bugs_org_fixed_release" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_bugs_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.linkedTestCaseId], foreignColumns: [testCases.orgId, testCases.id], name: "fk_bugs_org_test_case" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_bugs_org_ticket" }).onDelete("set null"),
  index("idx_bugs_org_project_status").on(table.orgId, table.projectId, table.status).where(sql`deleted_at IS NULL`),
  index("idx_bugs_org_project_severity").on(table.orgId, table.projectId, table.severity).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_bugs_project_number").on(table.projectId, table.bugNumber),
  index("idx_bugs_assignee").on(table.orgId, table.assigneeMembershipId),
  index("idx_bugs_org_assignee_membership").on(table.orgId, table.assigneeMembershipId),
  index("idx_bugs_org_qa_owner_membership").on(table.orgId, table.qaOwnerMembershipId),
  unique("uniq_bugs_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_bugs_assignee_actor",
    columns: [table.orgId, table.assigneeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
  foreignKey({
    name: "fk_bugs_qa_owner_actor",
    columns: [table.orgId, table.qaOwnerMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);
