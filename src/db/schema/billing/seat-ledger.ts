import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

/**
 * Billable seat inclusion rules (documented, not a separate table since they are
 * invariant to this billing model):
 *
 *   INVITE_SENT      → +1  (pending invitation counts against quota and against billing)
 *   INVITE_ACCEPTED  →  0  (the pending slot converts to a member slot; net unchanged)
 *   INVITE_EXPIRED   → -1  (expired invitation no longer counts)
 *   INVITE_CANCELLED → -1  (cancelled invitation no longer counts)
 *   MEMBER_SUSPENDED →  0  (suspended member stays in organization_members; still billed)
 *   MEMBER_REACTIVATED→ 0  (reactivated member was still billed during suspension)
 *   MEMBER_DEACTIVATED→ -1  (removed from organization_members; no longer billed)
 *   GUEST_ADDED      → +1  (external guest, billable — only when org plan bills guests)
 *   GUEST_REMOVED    → -1  (external guest removed)
 *
 * billed_quantity_after is always read from the live seatCount() expression immediately
 * after the triggering membership write, inside the same transaction, to ensure the
 * ledger and the enforcement gate agree on the seat count.
 */
export const billingSeatEvents = pgTable(
  "billing_seat_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 30 }).notNull(),
    subjectId: text("subject_id").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    effectiveAt: timestamp("effective_at").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    billedQuantityAfter: integer("billed_quantity_after").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_seat_events_idem")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("idx_billing_seat_events_org_time").on(t.orgId, t.effectiveAt.desc()),
    index("idx_billing_seat_events_org_subject").on(t.orgId, t.subjectId),
    unique("uniq_billing_seat_events_org_id").on(t.orgId, t.id),
  ],
);

export const billingSeatEventsRelations = relations(billingSeatEvents, ({ one }) => ({
  organization: one(organizations, { fields: [billingSeatEvents.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [billingSeatEvents.actorId], references: [users.id] }),
}));
