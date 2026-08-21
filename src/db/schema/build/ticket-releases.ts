import {
  text,
  timestamp,
  date,
  integer,
  index,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
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
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(),
    releaseDate: date("release_date"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
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
      .references(() => projectReleases.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_release_tickets").on(table.releaseId, table.ticketId),
    index("idx_release_tickets_release").on(table.releaseId),
  ],
);
