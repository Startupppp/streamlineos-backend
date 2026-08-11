import {
  pgTable,
  bigint,
  text,
  serial,
  timestamp,
  jsonb,
  decimal,
  date,
  integer,
  index,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  projectStatusEnum,
  stateGroupEnum,
  cycleStatusEnum,
  moduleStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { deals } from "../crm/deals";
import { managedProducts } from "./managed-products";
import { pmWorkspaces } from "./pm-workspaces";

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    key: text("key").notNull(),
    clientId: text("client_id").references(() => users.id),
    managerId: text("manager_id").references(() => users.id),
    startDate: timestamp("start_date"),
    endDate: timestamp("end_date"),
    status: projectStatusEnum("status").default("ACTIVE").notNull(),
    priority: text("priority"),
    dealId: integer("deal_id").references(() => deals.id, {
      onDelete: "set null",
    }),
    managedProductId: integer("managed_product_id").references(
      () => managedProducts.managedProductId,
      { onDelete: "set null" },
    ),
    pmWorkspaceId: text("pm_workspace_id").references(() => pmWorkspaces.pmWorkspaceId, { onDelete: "set null" }),
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
    uniqueIndex("uniq_projects_org_key").on(table.orgId, table.key).where(sql`deleted_at IS NULL`),
    index("idx_projects_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
    index("idx_projects_manager").on(table.managerId),
    index("idx_projects_deal").on(table.dealId),
    index("idx_projects_managed_product").on(table.managedProductId),
    index("idx_projects_name_trgm").using("gin", table.name.op("gin_trgm_ops")).where(sql`deleted_at IS NULL`),
    unique("uniq_projects_org_id").on(table.orgId, table.id),
  ],
);

export const sprints = pgTable(
  "sprints",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
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
    index("idx_sprints_project_status").on(table.projectId, table.status).where(sql`deleted_at IS NULL`),
    unique("uniq_sprints_org_id").on(table.orgId, table.id),
    check(
      "chk_sprints_status",
      sql`${table.status} IN ('PLANNED','ACTIVE','COMPLETED')`,
    ),
  ],
);

export const projectStatuses = pgTable(
  "project_statuses",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    color: text("color"),
    type: stateGroupEnum("type").default("unstarted"),
    wipLimit: integer("wip_limit"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_project_statuses_project").on(table.projectId),
    unique("uniq_project_statuses_org_id").on(table.orgId, table.id),
    unique("uniq_project_statuses_org_project_name").on(table.orgId, table.projectId, table.name),
  ],
);

export const cycles = pgTable(
  "cycles",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
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
    index("idx_cycles_project").on(table.projectId),
    index("idx_cycles_org_status").on(table.orgId, table.status),
    unique("uniq_cycles_org_id").on(table.orgId, table.id),
  ],
);

export const modules = pgTable(
  "modules",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
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
    index("idx_modules_project").on(table.projectId),
    index("idx_modules_org").on(table.orgId),
    unique("uniq_modules_org_id").on(table.orgId, table.id),
  ],
);

export const projectTemplates = pgTable(
  "project_templates",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").default("GENERAL").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_project_templates_org").on(table.orgId),
    unique("uniq_project_templates_org_id").on(table.orgId, table.id),
  ],
);

export const projectTemplateTickets = pgTable(
  "project_template_tickets",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: integer("template_id")
      .notNull()
      .references(() => projectTemplates.id, { onDelete: "cascade" }),
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
    index("idx_project_template_tickets_template").on(table.templateId),
    index("idx_project_template_tickets_org_template").on(table.orgId, table.templateId),
    unique("uniq_project_template_tickets_org_id").on(table.orgId, table.id),
  ],
);
