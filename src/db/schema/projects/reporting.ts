import { pgTable, text, serial, timestamp, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { projects } from "./core";

export const projectDailySnapshots = pgTable("project_daily_snapshots", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  stateGroup: text("state_group").notNull(),
  count: integer("count").default(0).notNull(),
  points: integer("points").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_project_daily_snapshots_project_date_group").on(table.projectId, table.snapshotDate, table.stateGroup),
  index("idx_project_daily_snapshots_org_project").on(table.orgId, table.projectId),
]);

export const projectDailySnapshotsRelations = relations(projectDailySnapshots, ({ one }) => ({
  project: one(projects, { fields: [projectDailySnapshots.projectId], references: [projects.id] }),
}));
