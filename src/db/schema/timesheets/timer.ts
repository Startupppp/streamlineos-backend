import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "../build/core";
import { tickets } from "../build/tasks";
import { timerSessionStatusEnum, timerSessionSourceEnum } from "./enums";

export const timerSessions = pgTable("timer_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userMembershipId: integer("user_membership_id"),
  projectId: integer("project_id"),
  ticketId: integer("ticket_id"),
  description: text("description"),
  billable: boolean("billable").notNull().default(false),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastResumedAt: timestamp("last_resumed_at"),
  accumulatedSeconds: integer("accumulated_seconds").notNull().default(0),
  status: timerSessionStatusEnum("status").notNull().default("RUNNING"),
  source: timerSessionSourceEnum("source").notNull().default("WEB"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_timer_sessions_ticket_id_org" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_timer_sessions_project_id_org" }).onDelete("set null"),
  index("idx_timer_sessions_user_membership_status").on(t.orgId, t.userMembershipId, t.status),
  index("idx_timer_sessions_ticket").on(t.ticketId),
  index("idx_timer_sessions_project").on(t.projectId),
  index("idx_timer_sessions_org_user_membership").on(t.orgId, t.userMembershipId),
  foreignKey({
    columns: [t.orgId, t.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timer_sessions_user_membership",
  }).onDelete("set null"),
]);
