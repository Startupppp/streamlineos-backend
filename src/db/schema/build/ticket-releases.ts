import { check, date, foreignKey, index, integer, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./ticket-core";

export const projectReleases = build.table(
  "project_releases",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(),
    releaseDate: date("release_date"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    rowVersion: integer("row_version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_releases_org_project" }).onDelete("cascade"),
    index("idx_project_releases_project").on(table.projectId).where(sql`deleted_at IS NULL`),
    index("idx_project_releases_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
    unique("uniq_project_releases_org_id").on(table.orgId, table.id),
    check(
      "chk_project_releases_status",
      sql`${table.status} IN ('draft','released','archived')`,
    ),
  ],
);

export const releaseTickets = build.table(
  "release_tickets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    releaseId: integer("release_id")
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.releaseId], foreignColumns: [projectReleases.orgId, projectReleases.id], name: "fk_release_tickets_org_release" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_release_tickets_org_ticket" }).onDelete("cascade"),
    uniqueIndex("uniq_release_tickets").on(table.releaseId, table.ticketId),
    unique("uniq_release_tickets_org_id").on(table.orgId, table.id),
  ],
);
