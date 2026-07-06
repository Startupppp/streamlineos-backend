import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { supportTicketPriorityEnum } from "../enums";

export interface WeeklyScheduleDay {
  start: string;
  end: string;
}

export type WeeklySchedule = Partial<
  Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", WeeklyScheduleDay>
>;

export const supportBusinessHours = pgTable(
  "support_business_hours",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    weeklySchedule: jsonb("weekly_schedule").$type<WeeklySchedule>().default({}).notNull(),
    holidays: jsonb("holidays").$type<string[]>().default([]).notNull(),
    is24x7: boolean("is_24x7").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [index("idx_support_business_hours_org").on(table.orgId)],
);

export const supportSlaPolicies = pgTable(
  "support_sla_policies",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    priority: supportTicketPriorityEnum("priority"),
    category: text("category"),
    businessHoursId: integer("business_hours_id"),
    firstResponseTargetMins: integer("first_response_target_mins").notNull(),
    resolutionTargetMins: integer("resolution_target_mins").notNull(),
    pauseStatuses: jsonb("pause_statuses").$type<string[]>().default(["WAITING"]).notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_support_sla_policies_org_enabled").on(table.orgId, table.isEnabled),
  ],
);

export const supportBusinessHoursRelations = relations(supportBusinessHours, ({ one }) => ({
  organization: one(organizations, { fields: [supportBusinessHours.orgId], references: [organizations.id] }),
}));

export const supportSlaPoliciesRelations = relations(supportSlaPolicies, ({ one }) => ({
  organization: one(organizations, { fields: [supportSlaPolicies.orgId], references: [organizations.id] }),
}));
