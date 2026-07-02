import { pgTable, text, timestamp, boolean, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users, organizations } from "./auth";

export const userMemberships = pgTable("user_memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  businessUnitId: text("business_unit_id"),
  branchId: integer("branch_id"),
  departmentId: integer("department_id"),
  teamId: text("team_id"),
  managerUserId: text("manager_user_id").references(() => users.id, { onDelete: "set null" }),
  isPrimary: boolean("is_primary").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_user_memberships_user_org").on(table.userId, table.orgId),
  index("idx_user_memberships_org").on(table.orgId),
  index("idx_user_memberships_manager").on(table.managerUserId),
  index("idx_user_memberships_dept").on(table.departmentId),
  index("idx_user_memberships_branch").on(table.branchId),
  index("idx_user_memberships_team").on(table.teamId),
  index("idx_user_memberships_bu").on(table.businessUnitId),
]);

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").default("system").notNull(),
  language: text("language").default("en").notNull(),
  timezone: text("timezone").default("Asia/Kolkata").notNull(),
  dateFormat: text("date_format").default("DD/MM/YYYY").notNull(),
  timeFormat: text("time_format").default("12h").notNull(),
  numberFormat: text("number_format").default("1,234.56"),
  weekStartDay: text("week_start_day").default("monday"),
  accentColor: text("accent_color"),
  density: text("density").default("comfortable"),
  fontSize: text("font_size").default("medium"),
  reducedMotion: boolean("reduced_motion").default(false),
  highContrast: boolean("high_contrast").default(false),
  notificationPreferences: jsonb("notification_preferences").$type<Record<string, boolean>>().default({}).notNull(),
  dashboardPreferences: jsonb("dashboard_preferences").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const userMembershipsRelations = relations(userMemberships, ({ one }) => ({
  user: one(users, { fields: [userMemberships.userId], references: [users.id] }),
  org: one(organizations, { fields: [userMemberships.orgId], references: [organizations.id] }),
  manager: one(users, { fields: [userMemberships.managerUserId], references: [users.id], relationName: "membershipManager" }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));

