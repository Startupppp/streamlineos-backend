import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./auth";

export const PURGE_ADAPTER_STATES = [
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "NOT_APPLICABLE",
] as const;

export type PurgeAdapterState = (typeof PURGE_ADAPTER_STATES)[number];

export const purgeAdapterStateEnum = pgEnum(
  "organization_purge_adapter_state",
  PURGE_ADAPTER_STATES,
);

export const PURGE_ADAPTERS = [
  "database_rows",
  "object_storage",
  "cache",
  "search_index",
  "vector_index",
  "analytics_copies",
  "provider_mirrors",
  "backups",
  "audit_evidence",
] as const;

export type PurgeAdapter = (typeof PURGE_ADAPTERS)[number];

export const organizationPurgeConfirmations = pgTable(
  "organization_purge_confirmations",
  {
    confirmationId: uuid("confirmation_id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    purgeJobId: text("purge_job_id").notNull(),
    adapter: text("adapter").notNull(),
    state: purgeAdapterStateEnum("state").default("PENDING").notNull(),
    detail: text("detail"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_org_purge_confirmations_job_adapter").on(
      table.orgId,
      table.purgeJobId,
      table.adapter,
    ),
    index("idx_org_purge_confirmations_org_state").on(table.orgId, table.state),
  ],
);

export const organizationLegalHolds = pgTable(
  "organization_legal_holds",
  {
    holdId: uuid("hold_id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    reason: text("reason").notNull(),
    placedBy: text("placed_by").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_org_legal_holds_active").on(table.orgId, table.releasedAt),
  ],
);
