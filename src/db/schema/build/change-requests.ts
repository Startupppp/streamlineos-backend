import { pgEnum, text, timestamp, integer, boolean, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "./core";
import { projectReleases } from "./ticket-releases";
import { tickets } from "./ticket-core";

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

export const changeRequests = build.table("change_requests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
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
  approvalOwnerMembershipId: integer("approval_owner_membership_id"),
  decisionComment: text("decision_comment"),
  decidedAt: timestamp("decided_at"),
  releaseId: integer("release_id"),
  clientVisible: boolean("client_visible").notNull().default(false),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_change_requests_org_project" }).onDelete("cascade"),
  index("idx_change_requests_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_change_requests_project_number").on(t.projectId, t.crNumber),
  index("idx_change_requests_requested_by").on(t.requestedById),
  index("idx_change_requests_org_approval_owner_membership").on(t.orgId, t.approvalOwnerMembershipId),
  index("idx_change_requests_org_release").on(t.orgId, t.releaseId).where(sql`release_id IS NOT NULL AND deleted_at IS NULL`),
  index("idx_change_requests_org_client_visible").on(t.orgId, t.clientVisible).where(sql`deleted_at IS NULL`),
  unique("uniq_change_requests_org_id").on(t.orgId, t.id),
  foreignKey({
    name: "fk_change_requests_approval_owner_actor",
    columns: [t.orgId, t.approvalOwnerMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
  foreignKey({
    name: "fk_change_requests_org_release",
    columns: [t.orgId, t.releaseId],
    foreignColumns: [projectReleases.orgId, projectReleases.id],
  }).onDelete("set null"),
]);

export const changeRequestAffectedItems = build.table("change_request_affected_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  changeRequestId: integer("change_request_id").notNull(),
  ticketId: integer("ticket_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  foreignKey({
    name: "fk_change_request_affected_items_org_change_request",
    columns: [t.orgId, t.changeRequestId],
    foreignColumns: [changeRequests.orgId, changeRequests.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_change_request_affected_items_org_ticket",
    columns: [t.orgId, t.ticketId],
    foreignColumns: [tickets.orgId, tickets.id],
  }).onDelete("cascade"),
  uniqueIndex("uniq_change_request_affected_items_pair").on(t.changeRequestId, t.ticketId),
  index("idx_change_request_affected_items_org_cr").on(t.orgId, t.changeRequestId, t.ticketId),
  index("idx_change_request_affected_items_org_ticket").on(t.orgId, t.ticketId, t.changeRequestId),
  index("idx_change_request_affected_items_created_by").on(t.createdBy),
  unique("uniq_change_request_affected_items_org_id").on(t.orgId, t.id),
]);
