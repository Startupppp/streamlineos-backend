import { pgEnum, text, timestamp, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const incidentSeverityEnum = pgEnum("incident_severity", ["critical", "high", "medium", "low"]);
export const incidentStatusEnum = pgEnum("incident_status", ["detected", "investigating", "mitigating", "resolved", "postmortem", "closed"]);

export const projectIncidents = build.table("project_incidents", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
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
  linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_incidents_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_incidents_project_number").on(t.projectId, t.incidentNumber),
  index("idx_project_incidents_severity").on(t.severity),
  unique("uniq_project_incidents_org_id").on(t.orgId, t.id),
]);

export const incidentUpdates = build.table("incident_updates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  incidentId: integer("incident_id").references(() => projectIncidents.id, { onDelete: "cascade" }).notNull(),
  message: text("message").notNull(),
  newStatus: incidentStatusEnum("new_status"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_incident_updates_incident").on(t.incidentId),
  unique("uniq_incident_updates_org_id").on(t.orgId, t.id),
]);
