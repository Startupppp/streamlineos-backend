import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";

export const timesheetAuditEvents = pgTable("timesheet_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorMembershipId: integer("actor_membership_id"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  prevHash: text("prev_hash"),
  rowHash: text("row_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_timesheet_audit_entity").on(t.orgId, t.entityType, t.entityId, t.createdAt),
  foreignKey({
    columns: [t.orgId, t.actorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_audit_actor_membership",
  }).onDelete("set null"),
]);
