import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

export const KB_PURGE_STORES = [
  "visits",
  "favorites",
  "source_links",
  "reviews",
  "versions",
  "comments",
  "grants",
  "chunks",
  "analytics",
  "notifications",
  "page_rows",
  "blobs",
] as const;
export type KbPurgeStore = (typeof KB_PURGE_STORES)[number];

export const KB_PURGE_STATUSES = ["pending", "completed", "failed"] as const;
export type KbPurgeStatus = (typeof KB_PURGE_STATUSES)[number];

export const kbPagePurgeLedger = pgTable(
  "kb_page_purge_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").notNull(),
    store: text("store").notNull().$type<KbPurgeStore>(),
    status: text("status").notNull().default("pending").$type<KbPurgeStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedReason: text("failed_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uniq_kb_purge_ledger_org_page_store").on(
      table.orgId,
      table.pageId,
      table.store,
    ),
    index("idx_kb_purge_ledger_org_status_created").on(
      table.orgId,
      table.status,
      table.createdAt,
    ),
    index("idx_kb_purge_ledger_pending_global").on(table.status, table.createdAt).where(
      sql`${table.status} = 'pending'`,
    ),
    check(
      "chk_kb_purge_ledger_store",
      sql`${table.store} IN ('visits', 'favorites', 'source_links', 'reviews', 'versions', 'comments', 'grants', 'chunks', 'analytics', 'notifications', 'page_rows', 'blobs')`,
    ),
    check(
      "chk_kb_purge_ledger_status",
      sql`${table.status} IN ('pending', 'completed', 'failed')`,
    ),
  ],
);
