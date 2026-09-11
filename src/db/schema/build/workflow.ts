import { text, integer, boolean, jsonb, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects, projectStatuses } from "./core";

export const workflowTransitions = build.table("workflow_transitions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  fromStatusId: integer("from_status_id"),
  toStatusId: integer("to_status_id").notNull(),
  name: text("name"),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  requiredFields: jsonb("required_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedRoles: jsonb("allowed_roles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.fromStatusId], foreignColumns: [projectStatuses.orgId, projectStatuses.id], name: "fk_workflow_transitions_org_from_status" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.toStatusId], foreignColumns: [projectStatuses.orgId, projectStatuses.id], name: "fk_workflow_transitions_org_to_status" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_workflow_transitions_org_project" }).onDelete("cascade"),
  index("idx_workflow_transitions_org_project").on(t.orgId, t.projectId).where(sql`deleted_at IS NULL`),
  index("idx_workflow_transitions_from").on(t.fromStatusId),
  index("idx_workflow_transitions_to").on(t.toStatusId),
  unique("uniq_workflow_transitions_org_id").on(t.orgId, t.id),
  foreignKey({
    name: "fk_workflow_transitions_created_by_actor",
    columns: [t.orgId, t.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);
