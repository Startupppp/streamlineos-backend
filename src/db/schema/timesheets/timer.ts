import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { projects } from "../build/core";
import { tickets } from "../build/tasks";
import { timerSessionStatusEnum, timerSessionSourceEnum } from "./enums";

export const timerSessions = pgTable("timer_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
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
  index("idx_timer_sessions_user_status").on(t.orgId, t.userId, t.status),
  index("idx_timer_sessions_ticket").on(t.ticketId),
  index("idx_timer_sessions_project").on(t.projectId),
]);
