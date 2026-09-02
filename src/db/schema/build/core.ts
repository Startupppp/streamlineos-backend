import {
  bigint,
  text,
  timestamp,
  jsonb,
  decimal,
  date,
  integer,
  index,
  unique,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import {
  projectStatusEnum,
  stateGroupEnum,
  cycleStatusEnum,
  moduleStatusEnum,
} from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { deals } from "../crm/deals";
import { managedProducts } from "./managed-products";
import { pmWorkspaces } from "./pm-workspaces";

export const projects = build.table(
  "projects",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    key: text("key").notNull(),
    clientMembershipId: integer("client_membership_id"),
    managerMembershipId: integer("manager_membership_id"),
    startDate: timestamp("start_date"),
    endDate: timestamp("end_date"),
    status: projectStatusEnum("status").default("ACTIVE").notNull(),
    priority: text("priority"),
    dealId: integer("deal_id"),
    managedProductId: integer("managed_product_id"),
    pmWorkspaceId: text("pm_workspace_id").notNull(),
    budget: decimal("budget", { precision: 15, scale: 2 }),
    budgetMinor: bigint("budget_minor", { mode: "number" }),
    budgetCurrency: text("budget_currency"),
    settings: jsonb("settings").$type<{
      modules: {
        sprints: boolean;
        epics: boolean;
        timeTracking: boolean;
        wiki: boolean;
      };
      projectType?: string;
      workflow?: string;
      features?: Record<string, boolean>;
    }>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.managedProductId], foreignColumns: [managedProducts.orgId, managedProducts.id], name: "fk_projects_org_product" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.dealId], foreignColumns: [deals.orgId, deals.id], name: "fk_projects_deal_id_org" }).onDelete("set null"),
    uniqueIndex("uniq_projects_org_key").on(table.orgId, table.key).where(sql`deleted_at IS NULL`),
    index("idx_projects_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
    index("idx_projects_manager").on(table.orgId, table.managerMembershipId),
    index("idx_projects_org_client_membership").on(table.orgId, table.clientMembershipId),
    index("idx_projects_deal").on(table.dealId),
    index("idx_projects_managed_product").on(table.managedProductId),
    index("idx_projects_name_trgm").using("gin", table.name.op("gin_trgm_ops")).where(sql`deleted_at IS NULL`),
    unique("uniq_projects_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.pmWorkspaceId],
      foreignColumns: [pmWorkspaces.orgId, pmWorkspaces.pmWorkspaceId],
      name: "fk_projects_org_pm_workspace",
    }),
    foreignKey({
      name: "fk_projects_manager_actor",
      columns: [table.orgId, table.managerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
    foreignKey({
      name: "fk_projects_client_actor",
      columns: [table.orgId, table.clientMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);

export const sprints = build.table(
  "sprints",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull(),
    name: text("name").notNull(),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    goal: text("goal"),
    status: text("status").default("PLANNED").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_sprints_org_project" }).onDelete("cascade"),
    index("idx_sprints_project_status").on(table.projectId, table.status).where(sql`deleted_at IS NULL`),
    unique("uniq_sprints_org_id").on(table.orgId, table.id),
    check(
      "chk_sprints_status",
      sql`${table.status} IN ('PLANNED','ACTIVE','COMPLETED')`,
    ),
  ],
);

export const projectStatuses = build.table(
  "project_statuses",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    projectId: integer("project_id").notNull(),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    color: text("color"),
    type: stateGroupEnum("type").default("unstarted"),
    wipLimit: integer("wip_limit"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_statuses_org_project" }).onDelete("cascade"),
    index("idx_project_statuses_project").on(table.projectId),
    unique("uniq_project_statuses_org_id").on(table.orgId, table.id),
    unique("uniq_project_statuses_org_project_name").on(table.orgId, table.projectId, table.name),
  ],
);

export const cycles = build.table(
  "cycles",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id")
      .notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: cycleStatusEnum("status").default("draft").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_cycles_org_project" }).onDelete("cascade"),
    index("idx_cycles_project").on(table.projectId),
    index("idx_cycles_org_status").on(table.orgId, table.status),
    unique("uniq_cycles_org_id").on(table.orgId, table.id),
  ],
);

export const modules = build.table(
  "modules",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id")
      .notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: moduleStatusEnum("status").default("backlog").notNull(),
    leadId: text("lead_id").references(() => users.id),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_modules_org_project" }).onDelete("cascade"),
    index("idx_modules_project").on(table.projectId),
    unique("uniq_modules_org_id").on(table.orgId, table.id),
  ],
);

export const projectTemplates = build.table(
  "project_templates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").default("GENERAL").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_project_templates_org").on(table.orgId).where(sql`deleted_at IS NULL`),
    unique("uniq_project_templates_org_id").on(table.orgId, table.id),
  ],
);

export const projectTemplateTickets = build.table(
  "project_template_tickets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: integer("template_id")
      .notNull()
      ,
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").default("TASK").notNull(),
    priority: text("priority").default("MEDIUM").notNull(),
    estimatedHours: decimal("estimated_hours", { precision: 8, scale: 2 }),
    order: integer("order").notNull().default(0),
    phase: text("phase"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [projectTemplates.orgId, projectTemplates.id], name: "fk_project_template_tickets_org_template" }).onDelete("cascade"),
    index("idx_project_template_tickets_template").on(table.templateId),
    index("idx_project_template_tickets_org_template").on(table.orgId, table.templateId),
    unique("uniq_project_template_tickets_org_id").on(table.orgId, table.id),
  ],
);
