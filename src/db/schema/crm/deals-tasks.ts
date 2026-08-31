import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { taskEntityTypeEnum, taskStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    entityType: taskEntityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    type: text("type").notNull().default("CUSTOM"),
    status: taskStatusEnum("status").notNull().default("pending"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    assigneeId: text("assignee_id").references(() => users.id),
    assigneeMembershipId: integer("assignee_membership_id"),
    createdBy: text("created_by").references(() => users.id),
    createdByMembershipId: integer("created_by_membership_id"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    timezone: text("timezone"),
    recurrence: jsonb("recurrence").$type<{
      frequency: "DAILY" | "WEEKLY" | "MONTHLY";
      interval: number;
      endDate?: string;
    } | null>(),
    parentTaskId: integer("parent_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    isTemplate: boolean("is_template").notNull().default(false),
    templateName: text("template_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_tasks_org").on(table.orgId),
    index("idx_tasks_assignee").on(table.assigneeId),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_due_date").on(table.dueDate),
    index("idx_tasks_entity").on(table.entityType, table.entityId),
    index("idx_tasks_parent").on(table.parentTaskId),
    unique("uniq_tasks_org_id").on(table.orgId, table.id),
  ],
);

export const taskSequences = pgTable(
  "task_sequences",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by").references(() => users.id),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("uniq_task_sequences_org_id").on(t.orgId, t.id)],
);

export const taskSequenceSteps = pgTable("task_sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id")
    .notNull()
    .references(() => taskSequences.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type").notNull().default("CUSTOM"),
  notes: text("notes"),
  offsetDays: integer("offset_days").notNull().default(0),
  order: integer("order").notNull().default(0),
});

export const tasksRelations = relations(tasks, ({ one }) => ({
  organization: one(organizations, {
    fields: [tasks.orgId],
    references: [organizations.id],
  }),
  assignee: one(users, {
    fields: [tasks.assigneeId],
    references: [users.id],
    relationName: "taskAssignee",
  }),
  createdByUser: one(users, {
    fields: [tasks.createdBy],
    references: [users.id],
    relationName: "taskCreator",
  }),
  parentTask: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: "childTasks",
  }),
}));

export const taskSequencesRelations = relations(
  taskSequences,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [taskSequences.orgId],
      references: [organizations.id],
    }),
    creator: one(users, {
      fields: [taskSequences.createdBy],
      references: [users.id],
    }),
    steps: many(taskSequenceSteps),
  }),
);

export const taskSequenceStepsRelations = relations(
  taskSequenceSteps,
  ({ one }) => ({
    sequence: one(taskSequences, {
      fields: [taskSequenceSteps.sequenceId],
      references: [taskSequences.id],
    }),
  }),
);
