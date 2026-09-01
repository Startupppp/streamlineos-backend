import { pgTable, text, serial, timestamp, date, integer, index, unique, jsonb, foreignKey } from "drizzle-orm/pg-core";
import { organizationMembers, organizations, users } from "../common/auth";
import { shiftTemplates } from "./shifts";

export const rosters = pgTable("rosters", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  weekStart: date("week_start").notNull(),
  weekEnd: date("week_end").notNull(),
  status: text("status").default("DRAFT").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_rosters_org_id").on(table.orgId, table.id),
  index("idx_rosters_org_week").on(table.orgId, table.weekStart),
]);

export const rosterEntries = pgTable("roster_entries", {
  id: serial("id").primaryKey(),
  rosterId: integer("roster_id").references(() => rosters.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  shiftId: integer("shift_id").references(() => shiftTemplates.id),
  date: date("date").notNull(),
  isDayOff: jsonb("is_day_off").$type<boolean>().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_roster_entries_roster").on(table.rosterId),
  index("idx_roster_entries_user_date").on(table.userId, table.date),
  index("idx_roster_entries_org_user_membership_date").on(table.orgId, table.userMembershipId, table.date),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_roster_entries_user_actor" }).onDelete("set null"),
]);
