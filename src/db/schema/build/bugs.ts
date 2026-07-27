import { pgTable, pgEnum, text, serial, timestamp, integer, index, unique, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets, projectReleases } from "./tasks";
import { testCases } from "./qa";

export const bugSeverityEnum = pgEnum("bug_severity", ["blocker", "critical", "major", "minor", "trivial"]);
export const bugPriorityEnum = pgEnum("bug_priority", ["low", "medium", "high", "urgent"]);
export const bugStatusEnum = pgEnum("bug_status", ["new", "triaged", "assigned", "in_progress", "fixed", "ready_for_qa", "verified", "reopened", "closed"]);

export const bugs = pgTable("bugs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
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
  affectedReleaseId: integer("affected_release_id").references(() => projectReleases.id, { onDelete: "set null" }),
  fixedReleaseId: integer("fixed_release_id").references(() => projectReleases.id, { onDelete: "set null" }),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
  qaOwnerId: text("qa_owner_id").references(() => users.id, { onDelete: "set null" }),
  reopenCount: integer("reopen_count").default(0).notNull(),
  linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  linkedTestCaseId: integer("linked_test_case_id").references((): AnyPgColumn => testCases.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_bugs_org_project_status").on(table.orgId, table.projectId, table.status),
  index("idx_bugs_org_project_severity").on(table.orgId, table.projectId, table.severity),
  uniqueIndex("uq_bugs_project_number").on(table.projectId, table.bugNumber),
  index("idx_bugs_assignee").on(table.assigneeId),
  unique("uniq_bugs_org_id").on(table.orgId, table.id),
]);
