import { pgEnum, bigserial, text, integer, timestamp, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";
import { sprints } from "./core";
import { tickets } from "./ticket-core";
import { buildEvents } from "./namespaces";

export const sprintScopeEventTypeEnum = pgEnum("sprint_scope_event_type", [
  "added",
  "removed",
  "estimate_changed",
  "completed",
  "reopened",
]);

export const sprintScopeEvents = buildEvents.table(
  "sprint_scope_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sprintId: integer("sprint_id")
      .references(() => sprints.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    eventType: sprintScopeEventTypeEnum("event_type").notNull(),
    previousPoints: integer("previous_points"),
    newPoints: integer("new_points"),
    actorId: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_sprint_scope_events_org_sprint_created").on(
      table.orgId,
      table.sprintId,
      table.createdAt,
    ),
    index("idx_sprint_scope_events_ticket").on(table.ticketId),
  ],
);
