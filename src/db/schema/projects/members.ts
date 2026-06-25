import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, foreignKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  intakeStatusEnum,
  intakeSourceEnum,
  viewLayoutEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const projectStatuses = pgTable("project_statuses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  order: integer("order").notNull().default(0),
  color: text("color"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_project_statuses_project").on(table.projectId),
]);

export const projectMembers = pgTable("project_members", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("CONTRIBUTOR").notNull(),
  hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }).default("0").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_project_members_project_user").on(table.projectId, table.userId),
  index("idx_project_members_user").on(table.userId),
]);

export const projectViews = pgTable("project_views", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  name: text("name").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
  groupBy: text("group_by"),
  orderBy: text("order_by"),
  layoutType: viewLayoutEnum("layout_type").default("board").notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_project_views_project").on(table.projectId),
  index("idx_project_views_org").on(table.orgId),
]);

export const intakeItems = pgTable("intake_items", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: jsonb("description"),
  source: intakeSourceEnum("source").default("manual").notNull(),
  status: intakeStatusEnum("status").default("pending").notNull(),
  submitterEmail: text("submitter_email"),
  linkedWorkItemId: integer("linked_work_item_id").references(() => tickets.id, { onDelete: "set null" }),
  declineReason: text("decline_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_intake_items_project").on(table.projectId),
  index("idx_intake_items_org_status").on(table.orgId, table.status),
]);

export const pages = pgTable("pages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
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
  foreignKey({ columns: [table.parentPageId], foreignColumns: [table.id] }).onDelete("cascade"),
  index("idx_pages_project").on(table.projectId),
  index("idx_pages_org").on(table.orgId),
  index("idx_pages_parent").on(table.parentPageId),
]);

export const projectMilestones = pgTable("project_milestones", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  targetDate: date("target_date").notNull(),
  status: text("status").notNull().default("PENDING"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_project_milestones_project").on(table.projectId),
  index("idx_project_milestones_org").on(table.orgId),
]);
