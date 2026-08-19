import { text, integer, bigint, timestamp, primaryKey } from "drizzle-orm/pg-core";
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
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    nextTicketNumber: bigint("next_ticket_number", { mode: "number" })
      .default(1)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "project_ticket_counters_pkey",
      columns: [table.orgId, table.projectId],
    }),
  ],
);
