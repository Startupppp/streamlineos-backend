import { pgTable, text, serial, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { projects } from "./core";

export interface WhiteboardElement {
  id: string;
  type: "note" | "rect" | "ellipse" | "text";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
}

export const projectWhiteboards = pgTable("project_whiteboards", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  data: jsonb("data").$type<WhiteboardElement[]>().default([]).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_project_whiteboards_org_project").on(table.orgId, table.projectId),
]);

export const projectWhiteboardsRelations = relations(projectWhiteboards, ({ one }) => ({
  project: one(projects, { fields: [projectWhiteboards.projectId], references: [projects.id] }),
}));
