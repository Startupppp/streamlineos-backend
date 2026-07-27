import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const timesheetAuditEvents = pgTable("timesheet_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_timesheet_audit_entity").on(t.orgId, t.entityType, t.entityId, t.createdAt),
]);
