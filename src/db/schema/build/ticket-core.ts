import {
  pgTable,
  text,
  serial,
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
import { sql } from "drizzle-orm";
import {
  ticketTypeEnum,
  ticketPriorityEnum,
  workItemRelationTypeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { projects, sprints, customStates, modules, cycles } from "./core";
import { clients } from "../crm/contacts";

export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
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
    assigneeId: text("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reporterId: text("reporter_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    stateId: integer("state_id").references(() => customStates.id, {
      onDelete: "set null",
    }),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({ columns: [t.epicId], foreignColumns: [t.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      columns: [t.parentTicketId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [t.recurrenceParentId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [t.customerId],
      foreignColumns: [clients.id],
    }).onDelete("set null"),
    uniqueIndex("uniq_tickets_project_number").on(t.projectId, t.ticketNumber),
    index("idx_tickets_project_status").on(t.projectId, t.status),
    index("idx_tickets_org_assignee_status").on(t.orgId, t.assigneeId, t.status),
    index("idx_tickets_org_assignee_due_open")
      .on(t.orgId, t.assigneeId, t.dueDate)
      .where(sql`status <> 'DONE'`),
    index("idx_tickets_sprint").on(t.sprintId),
    index("idx_tickets_org_status_priority").on(t.orgId, t.status, t.priority),
    index("idx_tickets_org_project_status").on(t.orgId, t.projectId, t.status),
    index("idx_tickets_org_project_rank").on(t.orgId, t.projectId, t.rank),
    index("idx_tickets_cycle").on(t.cycleId),
    index("idx_tickets_parent").on(t.parentTicketId),
    index("idx_tickets_recurrence_next")
      .on(t.recurrenceNextRunAt)
      .where(sql`is_recurring = true`),
    index("idx_tickets_customer").on(t.customerId),
    index("idx_tickets_title_trgm").using("gin", t.title.op("gin_trgm_ops")),
    unique("uniq_tickets_org_id").on(t.orgId, t.id),
  ],
);

export const workItemRelations = pgTable(
  "work_item_relations",
  {
    id: serial("id").primaryKey(),
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
