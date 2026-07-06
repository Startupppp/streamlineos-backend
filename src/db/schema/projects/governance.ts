import { pgTable, pgEnum, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const riskProbabilityEnum = pgEnum("risk_probability", ["low", "medium", "high"]);
export const riskImpactEnum = pgEnum("risk_impact", ["low", "medium", "high"]);
export const riskStatusEnum = pgEnum("risk_status", ["open", "mitigating", "monitoring", "accepted", "closed"]);
export const decisionStatusEnum = pgEnum("decision_status", ["proposed", "accepted", "superseded", "revisit"]);

export const projectRisks = pgTable("project_risks", {
  id: serial("id").primaryKey(),
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
  index("idx_project_risks_org_project_status").on(t.orgId, t.projectId, t.status),
  uniqueIndex("uq_project_risks_project_number").on(t.projectId, t.riskNumber),
  index("idx_project_risks_owner").on(t.ownerId),
]);

export const projectDecisions = pgTable("project_decisions", {
  id: serial("id").primaryKey(),
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
  index("idx_project_decisions_org_project_status").on(t.orgId, t.projectId, t.status),
  uniqueIndex("uq_project_decisions_project_number").on(t.projectId, t.decisionNumber),
]);
