import {
  text,
  timestamp,
  boolean,
  decimal,
  date,
  integer,
  numeric,
  foreignKey,
  index,
  unique,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import {
  ticketTypeEnum,
  ticketPriorityEnum,
  workItemRelationTypeEnum,
} from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects, sprints, projectStatuses, modules, cycles } from "./core";
import { clients } from "../crm/contacts";

export const tickets = build.table(
  "tickets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    type: ticketTypeEnum("type").default("TASK").notNull(),
    status: text("status").notNull().default("TODO"),
    priority: ticketPriorityEnum("priority").default("MEDIUM").notNull(),
    projectId: integer("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    ticketNumber: integer("ticket_number").notNull(),
    sprintId: integer("sprint_id").references(() => sprints.id, {
      onDelete: "set null",
    }),
    epicId: integer("epic_id"),
    assigneeMembershipId: integer("assignee_membership_id"),
    reporterId: text("reporter_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reporterMembershipId: integer("reporter_membership_id"),
    points: integer("points"),
    storyPoints: integer("story_points"),
    link: text("link"),
    rank: numeric("rank").notNull().default("1000"),
    parentTicketId: integer("parent_ticket_id"),
    originalEstimate: decimal("original_estimate", { precision: 10, scale: 2 }),
    timeSpent: decimal("time_spent", { precision: 10, scale: 2 })
      .default("0")
      .notNull(),
    startDate: date("start_date"),
    dueDate: date("due_date"),
    moduleId: integer("module_id").references(() => modules.id, {
      onDelete: "set null",
    }),
    cycleId: integer("cycle_id").references(() => cycles.id, {
      onDelete: "set null",
    }),
    sequenceId: text("sequence_id"),
    estimate: integer("estimate"),
    completionPercentage: integer("completion_percentage").default(0).notNull(),
    clientVisible: boolean("client_visible").notNull().default(false),
    isRecurring: boolean("is_recurring").notNull().default(false),
    recurrenceRule: jsonb("recurrence_rule").$type<{
      frequency: "daily" | "weekly" | "monthly";
      interval: number;
      daysOfWeek?: number[];
      endDate?: string | null;
    }>(),
    recurrenceParentId: integer("recurrence_parent_id"),
    recurrenceNextRunAt: timestamp("recurrence_next_run_at", {
      withTimezone: true,
    }),
    customerId: integer("customer_id"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.epicId], foreignColumns: [t.orgId, t.id], name: "fk_tickets_org_epic" }),
    foreignKey({ columns: [t.orgId, t.parentTicketId], foreignColumns: [t.orgId, t.id], name: "fk_tickets_org_parent" }),
    foreignKey({ columns: [t.orgId, t.recurrenceParentId], foreignColumns: [t.orgId, t.id], name: "fk_tickets_org_recurrence_parent" }),
    foreignKey({
      columns: [t.customerId],
      foreignColumns: [clients.id],
    }).onDelete("set null"),
    foreignKey({
      name: "fk_tickets_status",
      columns: [t.orgId, t.projectId, t.status],
      foreignColumns: [projectStatuses.orgId, projectStatuses.projectId, projectStatuses.name],
    }).onUpdate("cascade"),
    uniqueIndex("uniq_tickets_project_number").on(t.projectId, t.ticketNumber),
    index("idx_tickets_project_status").on(t.projectId, t.status),
    index("idx_tickets_org_assignee_status").on(t.orgId, t.assigneeMembershipId, t.status),
    index("idx_tickets_org_assignee_due_open")
      .on(t.orgId, t.assigneeMembershipId, t.dueDate)
      .where(sql`status <> 'DONE'`),
    index("idx_tickets_org_assignee_membership").on(t.orgId, t.assigneeMembershipId),
    index("idx_tickets_org_reporter_membership").on(t.orgId, t.reporterMembershipId),
    index("idx_tickets_sprint").on(t.sprintId),
    index("idx_tickets_org_status_priority").on(t.orgId, t.status, t.priority),
    index("idx_tickets_org_project_status").on(t.orgId, t.projectId, t.status),
    index("idx_tickets_org_project_rank")
      .on(t.orgId, t.projectId, t.rank)
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_org_project_rank_sort")
      .on(t.orgId, t.projectId, t.rank.asc(), t.createdAt.desc(), t.id.asc())
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_org_project_created")
      .on(t.orgId, t.projectId, t.createdAt.desc(), t.id.asc())
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_org_project_updated")
      .on(t.orgId, t.projectId, t.updatedAt.desc(), t.createdAt.desc(), t.id.asc())
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_org_project_priority")
      .on(t.orgId, t.projectId, t.priority.asc(), t.createdAt.desc(), t.id.asc())
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_org_project_due_date")
      .on(t.orgId, t.projectId, t.dueDate.asc(), t.createdAt.desc(), t.id.asc())
      .where(sql`deleted_at IS NULL`),
    index("idx_tickets_cycle").on(t.cycleId),
    index("idx_tickets_parent").on(t.parentTicketId),
    index("idx_tickets_recurrence_next")
      .on(t.recurrenceNextRunAt)
      .where(sql`is_recurring = true`),
    index("idx_tickets_customer").on(t.customerId),
    index("idx_tickets_title_trgm").using("gin", t.title.op("gin_trgm_ops")),
    unique("uniq_tickets_org_id").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.assigneeMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_tickets_assignee_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.orgId, t.reporterMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_tickets_reporter_actor",
    }).onDelete("restrict"),
  ],
);

export const workItemRelations = build.table(
  "work_item_relations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    workItemId: integer("work_item_id")
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    relatedWorkItemId: integer("related_work_item_id")
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    relationType: workItemRelationTypeEnum("relation_type").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_work_item_relation").on(
      table.workItemId,
      table.relatedWorkItemId,
    ),
    index("idx_work_item_relations_item").on(table.workItemId),
    index("idx_work_item_relations_related").on(table.relatedWorkItemId),
  ],
);
