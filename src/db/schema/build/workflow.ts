import { pgTable, text, serial, integer, boolean, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects, projectStatuses } from "./core";

export const workflowTransitions = pgTable("workflow_transitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  fromStatusId: integer("from_status_id").references(() => projectStatuses.id, { onDelete: "cascade" }),
  toStatusId: integer("to_status_id").references(() => projectStatuses.id, { onDelete: "cascade" }).notNull(),
  name: text("name"),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  requiredFields: jsonb("required_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedRoles: jsonb("allowed_roles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_workflow_transitions_org_project").on(t.orgId, t.projectId).where(sql`deleted_at IS NULL`),
  index("idx_workflow_transitions_from").on(t.fromStatusId),
  index("idx_workflow_transitions_to").on(t.toStatusId),
  unique("uniq_workflow_transitions_org_id").on(t.orgId, t.id),
]);
