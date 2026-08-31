import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const providerWebhookEvents = pgTable(
  "provider_webhook_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_provider_webhook_events_provider_event").on(t.orgId, t.provider, t.providerEventId),
    index("idx_provider_webhook_events_org_created").on(t.orgId, t.createdAt),
    index("idx_provider_webhook_events_unprocessed").on(t.orgId, t.createdAt).where(
      sql`processed_at IS NULL`,
    ),
  ],
);
