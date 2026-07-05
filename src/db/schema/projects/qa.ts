import { pgTable, pgEnum, text, serial, timestamp, integer, index, uniqueIndex, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../auth";
import { projects, sprints } from "./core";
import { tickets, projectReleases } from "./tasks";
import { bugs } from "./bugs";

export const testCasePriorityEnum = pgEnum("test_case_priority", ["low", "medium", "high"]);
export const testCaseAutomationStatusEnum = pgEnum("test_case_automation_status", ["manual", "automated", "planned"]);
export const testRunStatusEnum = pgEnum("test_run_status", ["not_started", "in_progress", "completed", "aborted"]);
export const testResultStatusEnum = pgEnum("test_result_status", ["not_run", "passed", "failed", "blocked", "skipped"]);

export const testSuites = pgTable("test_suites", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: integer("parent_id").references((): AnyPgColumn => testSuites.id, { onDelete: "set null" }),
  position: integer("position").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_test_suites_org_project").on(table.orgId, table.projectId),
  index("idx_test_suites_parent").on(table.parentId),
]);

export const testCases = pgTable("test_cases", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  suiteId: integer("suite_id").references(() => testSuites.id, { onDelete: "set null" }),
  caseNumber: integer("case_number").notNull(),
  title: text("title").notNull(),
  preconditions: text("preconditions"),
  steps: jsonb("steps").$type<{ action: string; expected: string }[]>().default(sql`'[]'::jsonb`),
  expectedResult: text("expected_result"),
  priority: testCasePriorityEnum("priority").default("medium").notNull(),
  component: text("component"),
  linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  automationStatus: testCaseAutomationStatusEnum("automation_status").default("manual").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_test_cases_org_project_suite").on(table.orgId, table.projectId, table.suiteId),
  uniqueIndex("uq_test_cases_project_number").on(table.projectId, table.caseNumber),
]);

export const testRuns = pgTable("test_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  runNumber: integer("run_number").notNull(),
  name: text("name").notNull(),
  sprintId: integer("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
  releaseId: integer("release_id").references(() => projectReleases.id, { onDelete: "set null" }),
  environment: text("environment"),
  browserDevice: text("browser_device"),
  testerId: text("tester_id").references(() => users.id, { onDelete: "set null" }),
  status: testRunStatusEnum("status").default("not_started").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_test_runs_org_project_status").on(table.orgId, table.projectId, table.status),
  index("idx_test_runs_sprint").on(table.sprintId),
  index("idx_test_runs_release").on(table.releaseId),
  uniqueIndex("uq_test_runs_project_number").on(table.projectId, table.runNumber),
]);

export const testRunResults = pgTable("test_run_results", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => testRuns.id, { onDelete: "cascade" }).notNull(),
  testCaseId: integer("test_case_id").references(() => testCases.id, { onDelete: "cascade" }).notNull(),
  status: testResultStatusEnum("status").default("not_run").notNull(),
  notes: text("notes"),
  executedBy: text("executed_by").references(() => users.id, { onDelete: "set null" }),
  executedAt: timestamp("executed_at"),
  linkedBugId: integer("linked_bug_id").references((): AnyPgColumn => bugs.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_test_run_results_run_case").on(table.runId, table.testCaseId),
  index("idx_test_run_results_org_project").on(table.orgId, table.projectId),
]);
