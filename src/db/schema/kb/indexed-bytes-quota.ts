import { pgTable, text, bigint, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

export const kbIndexedBytesQuota = pgTable(
  "kb_indexed_bytes_quota",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    indexedBytes: bigint("indexed_bytes", { mode: "number" }).notNull().default(0),
    limitBytes: bigint("limit_bytes", { mode: "number" }).notNull().default(536870912),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "chk_kb_indexed_bytes_quota_non_negative",
      sql`${table.indexedBytes} >= 0 AND ${table.limitBytes} >= 0`,
    ),
  ],
);
