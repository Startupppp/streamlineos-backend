import { bigint, foreignKey, integer, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations } from "../common/auth";
import { projects } from "./core";

export const projectTicketCounters = build.table(
  "project_ticket_counters",
  {
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull(),
    nextTicketNumber: bigint("next_ticket_number", { mode: "number" })
      .default(1)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_ticket_counters_project" }).onDelete("cascade"),
    primaryKey({
      name: "project_ticket_counters_pkey",
      columns: [table.orgId, table.projectId],
    }),
  ],
);
