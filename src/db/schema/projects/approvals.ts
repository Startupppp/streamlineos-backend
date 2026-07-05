import { pgTable, pgEnum, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "./core";

export const approvalEntityTypeEnum = pgEnum("approval_entity_type", [
  "task",
  "milestone",
  "budget",
  "release",
  "change_request",
  "document",
  "timesheet",
  "client_approval",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "requested",
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "escalated",
  "cancelled",
]);

export const projectApprovals = pgTable("project_approvals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  entityType: approvalEntityTypeEnum("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  title: text("title").notNull(),
  requestedById: text("requested_by_id").references(() => users.id, { onDelete: "set null" }),
  approverId: text("approver_id").references(() => users.id, { onDelete: "set null" }),
  status: approvalStatusEnum("status").notNull().default("pending"),
  level: integer("level").notNull().default(1),
  dueAt: timestamp("due_at"),
  decisionComment: text("decision_comment"),
  decidedAt: timestamp("decided_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_approvals_org_project_status").on(t.orgId, t.projectId, t.status),
  index("idx_project_approvals_approver_status").on(t.approverId, t.status),
  index("idx_project_approvals_entity").on(t.entityType, t.entityId),
]);
