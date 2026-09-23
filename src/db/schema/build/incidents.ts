import { foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";
import { projectReleases } from "./ticket-releases";

export const incidentSeverityEnum = pgEnum("incident_severity", ["critical", "high", "medium", "low"]);
export const incidentStatusEnum = pgEnum("incident_status", ["detected", "investigating", "mitigating", "resolved", "postmortem", "closed"]);
export const incidentFollowUpStatusEnum = pgEnum("incident_follow_up_status", ["open", "in_progress", "done", "cancelled"]);

export const projectIncidents = build.table("project_incidents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  incidentNumber: integer("incident_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  severity: incidentSeverityEnum("severity").notNull().default("medium"),
  status: incidentStatusEnum("status").notNull().default("detected"),
  impact: text("impact"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  rootCause: text("root_cause"),
  customerComms: text("customer_comms"),
  detectedAt: timestamp("detected_at"),
  respondedAt: timestamp("responded_at"),
  resolvedAt: timestamp("resolved_at"),
  responseDueAt: timestamp("response_due_at"),
  resolutionDueAt: timestamp("resolution_due_at"),
  linkedTicketId: integer("linked_ticket_id"),
  // Phase 5 postmortem field: the release this incident affected. `projectReleases`
  // is the codebase's one canonical release entity (`db/schema/build/ticket-releases.ts`)
  // — there is no separate "service" catalog table to link to, so a release is the
  // most specific "service or release" reference this schema can express; the
  // affected project (already the URL's :projectId) is the service-level grain.
  releaseId: integer("release_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_incidents_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_project_incidents_org_ticket" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.releaseId], foreignColumns: [projectReleases.orgId, projectReleases.id], name: "fk_project_incidents_org_release" }).onDelete("set null"),
  index("idx_project_incidents_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_incidents_project_number").on(t.projectId, t.incidentNumber),
  index("idx_project_incidents_severity").on(t.severity),
  index("idx_project_incidents_release").on(t.releaseId),
  unique("uniq_project_incidents_org_id").on(t.orgId, t.id),
]);

export const incidentUpdates = build.table("incident_updates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  incidentId: integer("incident_id").notNull(),
  message: text("message").notNull(),
  newStatus: incidentStatusEnum("new_status"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.incidentId], foreignColumns: [projectIncidents.orgId, projectIncidents.id], name: "fk_incident_updates_org_incident" }).onDelete("cascade"),
  index("idx_incident_updates_incident").on(t.incidentId),
  unique("uniq_incident_updates_org_id").on(t.orgId, t.id),
]);

/**
 * Phase 5 postmortem field: the decisions made while running the incident —
 * an append-only log, the same shape as `incidentUpdates` above (insert +
 * list, no update, no delete). Distinct from `incidentUpdates`: an update is a
 * status/communication log entry, a decision is "we chose to do X" and may
 * carry a rationale that is never itself a status transition.
 */
export const incidentDecisions = build.table("incident_decisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  incidentId: integer("incident_id").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale"),
  decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.incidentId], foreignColumns: [projectIncidents.orgId, projectIncidents.id], name: "fk_incident_decisions_org_incident" }).onDelete("cascade"),
  index("idx_incident_decisions_incident").on(t.incidentId),
  unique("uniq_incident_decisions_org_id").on(t.orgId, t.id),
]);

/**
 * Phase 5 postmortem field: follow-up actions, each with its own lifecycle
 * (status, owner, due date) — normalized per BE-42 rather than a JSONB array,
 * because each item is independently owned and independently transitions.
 */
export const incidentFollowUpActions = build.table("incident_follow_up_actions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  incidentId: integer("incident_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  status: incidentFollowUpStatusEnum("status").notNull().default("open"),
  dueAt: timestamp("due_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.incidentId], foreignColumns: [projectIncidents.orgId, projectIncidents.id], name: "fk_incident_follow_up_actions_org_incident" }).onDelete("cascade"),
  index("idx_incident_follow_up_actions_org_incident_status").on(t.orgId, t.incidentId, t.status).where(sql`deleted_at IS NULL`),
  unique("uniq_incident_follow_up_actions_org_id").on(t.orgId, t.id),
]);
