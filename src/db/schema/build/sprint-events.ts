import { pgEnum, bigserial, text, integer, timestamp, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { cycles, sprints } from "./core";
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
      .notNull(),
    cycleId: integer("cycle_id"),
    ticketId: integer("ticket_id")
      .notNull(),
    eventType: sprintScopeEventTypeEnum("event_type").notNull(),
    previousPoints: integer("previous_points"),
    newPoints: integer("new_points"),
    actorMembershipId: integer("actor_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.sprintId], foreignColumns: [sprints.orgId, sprints.id], name: "fk_sprint_scope_events_org_sprint" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.cycleId], foreignColumns: [cycles.orgId, cycles.id], name: "fk_sprint_scope_events_org_cycle" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_sprint_scope_events_org_ticket" }).onDelete("cascade"),
    index("idx_sprint_scope_events_org_sprint_created").on(
      table.orgId,
      table.sprintId,
      table.createdAt,
    ),
    index("idx_sprint_scope_events_ticket").on(table.ticketId),
    foreignKey({
      name: "fk_sprint_scope_events_actor",
      columns: [table.orgId, table.actorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);
