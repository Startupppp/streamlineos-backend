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
import { organizations } from "../common/auth";

export const billingUsageEvents = pgTable(
  "billing_usage_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    meterKey: varchar("meter_key", { length: 100 }).notNull(),
    subjectId: text("subject_id"),
    quantity: integer("quantity").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    sourceKey: varchar("source_key", { length: 200 }).notNull(),
    ingestedAt: timestamp("ingested_at").defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("uq_billing_usage_events_org_meter_src").on(t.orgId, t.meterKey, t.sourceKey),
    index("idx_billing_usage_events_org_meter_time").on(t.orgId, t.meterKey, t.occurredAt.desc()),
    index("idx_billing_usage_events_org_occurred").on(t.orgId, t.occurredAt.desc()),
    unique("uniq_billing_usage_events_org_id").on(t.orgId, t.id),
  ],
);

export const billingUsageRollups = pgTable(
  "billing_usage_rollups",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    meterKey: varchar("meter_key", { length: 100 }).notNull(),
    granularity: varchar("granularity", { length: 10 }).notNull(),
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    totalQuantity: bigint("total_quantity", { mode: "number" }).notNull(),
    eventCount: integer("event_count").notNull(),
    rebuiltAt: timestamp("rebuilt_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_usage_rollups_org_meter_gran_period").on(t.orgId, t.meterKey, t.granularity, t.periodStart),
    index("idx_billing_usage_rollups_org_meter").on(t.orgId, t.meterKey, t.periodStart.desc()),
    unique("uniq_billing_usage_rollups_org_id").on(t.orgId, t.id),
  ],
);

export const billingUsageReservations = pgTable(
  "billing_usage_reservations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    meterKey: varchar("meter_key", { length: 100 }).notNull(),
    subjectId: text("subject_id"),
    reservedQuantity: integer("reserved_quantity").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    settledAt: timestamp("settled_at"),
    settledQuantity: integer("settled_quantity"),
  },
  (t) => [
    uniqueIndex("uq_billing_usage_res_org_meter_idem").on(t.orgId, t.meterKey, t.idempotencyKey),
    index("idx_billing_usage_res_org_meter_active").on(t.orgId, t.meterKey)
      .where(sql`status = 'ACTIVE'`),
    index("idx_billing_usage_res_expires").on(t.expiresAt)
      .where(sql`status = 'ACTIVE'`),
    unique("uniq_billing_usage_reservations_org_id").on(t.orgId, t.id),
  ],
);

export const billingUsageEventsRelations = relations(billingUsageEvents, ({ one }) => ({
  organization: one(organizations, { fields: [billingUsageEvents.orgId], references: [organizations.id] }),
}));

export const billingUsageRollupsRelations = relations(billingUsageRollups, ({ one }) => ({
  organization: one(organizations, { fields: [billingUsageRollups.orgId], references: [organizations.id] }),
}));

export const billingUsageReservationsRelations = relations(billingUsageReservations, ({ one }) => ({
  organization: one(organizations, { fields: [billingUsageReservations.orgId], references: [organizations.id] }),
}));
