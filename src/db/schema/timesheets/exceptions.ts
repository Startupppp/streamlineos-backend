import {
  pgTable,
  text,
  serial,
  timestamp,
  date,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { timesheetPeriods } from "./periods";

export const timesheetExceptions = pgTable("timesheet_exceptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  periodId: integer("period_id").references(() => timesheetPeriods.id, { onDelete: "cascade" }),
  entryId: integer("entry_id"),
  rule: text("rule").notNull(),
  severity: text("severity").notNull().default("WARNING"),
  status: text("status").notNull().default("OPEN"),
  message: text("message").notNull(),
  details: jsonb("details"),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  resolutionReason: text("resolution_reason"),
  resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_ts_exceptions_org_status").on(t.orgId, t.status, t.severity),
  index("idx_ts_exceptions_user").on(t.orgId, t.userId),
  index("idx_ts_exceptions_period").on(t.periodId),
]);
