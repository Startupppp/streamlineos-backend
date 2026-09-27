import { check, foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
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
  projectId: integer("project_id").notNull(),
  riskNumber: integer("risk_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  probability: riskProbabilityEnum("probability").notNull().default("medium"),
  impact: riskImpactEnum("impact").notNull().default("medium"),
  status: riskStatusEnum("status").notNull().default("open"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  mitigation: text("mitigation"),
  category: text("category"),
  reviewDate: timestamp("review_date"),
  linkedTicketId: integer("linked_ticket_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_project_risks_org_ticket" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_risks_org_project" }).onDelete("cascade"),
  index("idx_project_risks_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_risks_project_number").on(t.projectId, t.riskNumber).where(sql`deleted_at IS NULL`),
  index("idx_project_risks_owner").on(t.ownerId),
  index("idx_project_risks_org_project_review_date").on(t.orgId, t.projectId, t.reviewDate).where(sql`deleted_at IS NULL`),
  unique("uniq_project_risks_org_id").on(t.orgId, t.id),
]);

export const projectDecisions = build.table("project_decisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  decisionNumber: integer("decision_number").notNull(),
  title: text("title").notNull(),
  context: text("context"),
  decision: text("decision"),
  optionsConsidered: text("options_considered"),
  status: decisionStatusEnum("status").notNull().default("proposed"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  revisitAt: timestamp("revisit_at"),
  supersededById: integer("superseded_by_id"),
  linkedTicketId: integer("linked_ticket_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_decisions_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_project_decisions_org_ticket" }).onDelete("set null"),
  index("idx_project_decisions_org_project_status").on(t.orgId, t.projectId, t.status).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_decisions_project_number").on(t.projectId, t.decisionNumber).where(sql`deleted_at IS NULL`),
  foreignKey({ columns: [t.orgId, t.supersededById], foreignColumns: [t.orgId, t.id], name: "fk_project_decisions_org_superseded_by" }).onDelete("set null"),
  index("idx_project_decisions_org_superseded_by").on(t.orgId, t.supersededById).where(sql`superseded_by_id IS NOT NULL`),
  check("chk_project_decisions_not_self_superseded", sql`${t.supersededById} IS NULL OR ${t.supersededById} <> ${t.id}`),
  unique("uniq_project_decisions_org_id").on(t.orgId, t.id),
]);
