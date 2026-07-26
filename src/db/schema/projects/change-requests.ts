import { pgTable, pgEnum, text, serial, timestamp, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "./core";

export const changeRequestStatusEnum = pgEnum("change_request_status", [
  "submitted",
  "under_review",
  "estimated",
  "awaiting_approval",
  "approved",
  "rejected",
  "in_progress",
  "completed",
]);

export const changeRequests = pgTable("change_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  crNumber: integer("cr_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  impact: text("impact"),
  estimateMinutes: integer("estimate_minutes"),
  budgetImpactCents: integer("budget_impact_cents"),
  timelineImpactDays: integer("timeline_impact_days"),
  status: changeRequestStatusEnum("status").notNull().default("submitted"),
  requestedById: text("requested_by_id").references(() => users.id, { onDelete: "set null" }),
  approvalOwnerId: text("approval_owner_id").references(() => users.id, { onDelete: "set null" }),
  decisionComment: text("decision_comment"),
  decidedAt: timestamp("decided_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_change_requests_org_project_status").on(t.orgId, t.projectId, t.status),
  uniqueIndex("uq_change_requests_project_number").on(t.projectId, t.crNumber),
  index("idx_change_requests_requested_by").on(t.requestedById),
  unique("uniq_change_requests_org_id").on(t.orgId, t.id),
]);
