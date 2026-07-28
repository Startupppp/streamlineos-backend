import { pgTable, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./auth";

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

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));
