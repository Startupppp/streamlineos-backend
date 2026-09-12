import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const timesheetAuditEvents = pgTable("timesheet_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * A historical pointer, deliberately without a foreign key. The row is a
   * link in a hash chain that covers this column; a referential action that
   * rewrote it on member departure (as ON DELETE SET NULL did until 1104)
   * changed the hashed input and broke the chain at that row. Readers resolve
   * the name through a LEFT JOIN on (org_id, id) and render a departed actor
   * as unresolved.
   */
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
]);
