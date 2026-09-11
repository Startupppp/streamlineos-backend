import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { stateGroupEnum } from "../common/enums";

export const hrPositionStatuses = pgTable(
  "hr_position_statuses",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    color: text("color"),
    lifecycleGroup: stateGroupEnum("lifecycle_group").notNull().default("unstarted"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_hr_position_statuses_org_id").on(table.orgId, table.id),
    unique("uniq_hr_position_statuses_org_name").on(table.orgId, table.name),
  ],
);

export const hrPositionTransitions = pgTable(
  "hr_position_transitions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromStatusId: integer("from_status_id"),
    toStatusId: integer("to_status_id")
      .notNull()
      ,
    name: text("name"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    requiredFields: jsonb("required_fields")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    allowedRoles: jsonb("allowed_roles")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.fromStatusId], foreignColumns: [hrPositionStatuses.orgId, hrPositionStatuses.id], name: "fk_hr_position_transitions_org_from_status" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.toStatusId], foreignColumns: [hrPositionStatuses.orgId, hrPositionStatuses.id], name: "fk_hr_position_transitions_org_to_status" }).onDelete("cascade"),
    unique("uniq_hr_position_transitions_org_id").on(table.orgId, table.id),
    index("idx_hr_position_transitions_org")
      .on(table.orgId)
      .where(sql`deleted_at IS NULL`),
    index("idx_hr_position_transitions_from").on(table.fromStatusId),
    index("idx_hr_position_transitions_to").on(table.toStatusId),
  ],
);
