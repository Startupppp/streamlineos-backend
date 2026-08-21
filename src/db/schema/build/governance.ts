import { pgEnum, text, timestamp, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const riskProbabilityEnum = pgEnum("risk_probability", ["low", "medium", "high"]);
export const riskImpactEnum = pgEnum("risk_impact", ["low", "medium", "high"]);
export const riskStatusEnum = pgEnum("risk_status", ["open", "mitigating", "monitoring", "accepted", "closed"]);
export const decisionStatusEnum = pgEnum("decision_status", ["proposed", "accepted", "superseded", "revisit"]);

export const projectRisks = build.table("project_risks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  riskNumber: integer("risk_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  probability: riskProbabilityEnum("probability").notNull().default("medium"),
  impact: riskImpactEnum("impact").notNull().default("medium"),
  status: riskStatusEnum("status").notNull().default("open"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  mitigation: text("mitigation"),
  linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_risks_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_risks_project_number").on(t.projectId, t.riskNumber),
  index("idx_project_risks_owner").on(t.ownerId),
  unique("uniq_project_risks_org_id").on(t.orgId, t.id),
]);

export const projectDecisions = build.table("project_decisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  decisionNumber: integer("decision_number").notNull(),
  title: text("title").notNull(),
  context: text("context"),
  decision: text("decision"),
  optionsConsidered: text("options_considered"),
  status: decisionStatusEnum("status").notNull().default("proposed"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  revisitAt: timestamp("revisit_at"),
  linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("idx_project_decisions_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_decisions_project_number").on(t.projectId, t.decisionNumber),
  unique("uniq_project_decisions_org_id").on(t.orgId, t.id),
]);
