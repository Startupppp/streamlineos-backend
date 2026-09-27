import {
  text,
  bigint,
  timestamp,
  boolean,
  jsonb,
  decimal,
  date,
  integer,
  foreignKey,
  index,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import {
  intakeStatusEnum,
  intakeSourceEnum,
  viewLayoutEnum,
} from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const projectMembers = build.table("project_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  membershipId: integer("membership_id").notNull(),
  role: text("role").default("CONTRIBUTOR").notNull(),
  hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }).default("0").notNull(),
  hourlyRateMinor: bigint("hourly_rate_minor", { mode: "number" }).default(0).notNull(),
  rateCurrency: text("rate_currency"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_members_org_project" }).onDelete("cascade"),
  uniqueIndex("uniq_project_members_project_user").on(table.projectId, table.membershipId),
  index("idx_project_members_org_member_membership").on(table.orgId, table.membershipId),
  unique("uniq_project_members_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_project_members_member_actor",
  }).onDelete("cascade"),
]);

export const projectViews = build.table("project_views", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  name: text("name").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
  groupBy: text("group_by"),
  orderBy: text("order_by"),
  layoutType: viewLayoutEnum("layout_type").default("board").notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  visibility: text("visibility").default("shared").notNull(),
  displayOptions: jsonb("display_options").$type<Record<string, unknown>>().default({}).notNull(),
  scope: text("scope").default("project").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_views_org_project" }).onDelete("cascade"),
  index("idx_project_views_project").on(table.projectId),
  index("idx_project_views_org_scope").on(table.orgId, table.scope),
  unique("uniq_project_views_org_id").on(table.orgId, table.id),
]);

export const intakeItems = build.table("intake_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: jsonb("description"),
  source: intakeSourceEnum("source").default("manual").notNull(),
  status: intakeStatusEnum("status").default("pending").notNull(),
  submitterEmail: text("submitter_email"),
  submitterName: text("submitter_name"),
  priority: text("priority"),
  requestType: text("request_type"),
  linkedWorkItemId: integer("linked_work_item_id"),
  declineReason: text("decline_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_intake_items_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.linkedWorkItemId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_intake_items_org_ticket" }).onDelete("set null"),
  index("idx_intake_items_project").on(table.projectId),
  index("idx_intake_items_org_status").on(table.orgId, table.status),
  unique("uniq_intake_items_org_id").on(table.orgId, table.id),
]);

export const pages = build.table("pages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  content: jsonb("content"),
  icon: text("icon"),
  coverImage: text("cover_image"),
  isPublic: boolean("is_public").default(false).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  parentPageId: integer("parent_page_id"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_pages_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.parentPageId], foreignColumns: [table.orgId, table.id], name: "fk_pages_org_parent" }).onDelete("cascade"),
  index("idx_pages_project").on(table.projectId),
  index("idx_pages_parent").on(table.parentPageId),
  unique("uniq_pages_org_id").on(table.orgId, table.id),
]);

export const projectMilestones = build.table("project_milestones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  targetDate: date("target_date").notNull(),
  status: text("status").notNull().default("PENDING"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  clientVisible: boolean("client_visible").notNull().default(false),
  version: integer("version").notNull().default(1),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_milestones_org_project" }).onDelete("cascade"),
  index("idx_project_milestones_project").on(table.projectId).where(sql`deleted_at IS NULL`),
  index("idx_project_milestones_org").on(table.orgId).where(sql`deleted_at IS NULL`),
  unique("uniq_project_milestones_org_id").on(table.orgId, table.id),
  check("chk_project_milestones_status", sql`${table.status} IN ('PENDING','ACHIEVED','MISSED')`),
]);
