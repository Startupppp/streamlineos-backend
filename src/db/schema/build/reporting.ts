import { bigserial, date, foreignKey, index, integer, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { projects } from "./core";

export const projectDailySnapshots = build.table("project_daily_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  stateGroup: text("state_group").notNull(),
  count: integer("count").default(0).notNull(),
  points: integer("points").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_daily_snapshots_org_project" }).onDelete("cascade"),
  uniqueIndex("uniq_project_daily_snapshots_project_date_group").on(table.projectId, table.snapshotDate, table.stateGroup),
  index("idx_project_daily_snapshots_org_project").on(table.orgId, table.projectId),
  unique("uniq_project_daily_snapshots_org_id").on(table.orgId, table.id),
]);

export const projectDailySnapshotsRelations = relations(projectDailySnapshots, ({ one }) => ({
  project: one(projects, { fields: [projectDailySnapshots.projectId], references: [projects.id] }),
}));
