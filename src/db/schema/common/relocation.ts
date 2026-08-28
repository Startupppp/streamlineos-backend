import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { RELOCATION_STATES } from "../../../common/relocation/relocation-state";

export const relocationStateEnum = pgEnum("relocation_state", RELOCATION_STATES);

export const relocationChecksumScopeEnum = pgEnum("relocation_checksum_scope", [
  "table",
  "partition",
  "object",
  "index",
]);

/**
 * No foreign key to `organizations`: the control plane and the cell may be
 * separate databases, and this row must be writable before and after the cell
 * owns the organization row — the same reason `organization_placement` carries
 * no FK.
 */
export const organizationRelocations = pgTable(
  "organization_relocations",
  {
    relocationId: bigint("relocation_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: text("organization_id").notNull(),
    sourceCell: text("source_cell").notNull(),
    targetCell: text("target_cell").notNull(),
    currentState: relocationStateEnum("current_state")
      .notNull()
      .default("ACTIVE_SOURCE"),
    placementVersionAtStart: integer("placement_version_at_start").notNull(),
    failureReason: text("failure_reason"),
    rollbackReason: text("rollback_reason"),
    tablesPlanned: integer("tables_planned").notNull().default(0),
    tablesCopied: integer("tables_copied").notNull().default(0),
    rowsCopied: bigint("rows_copied", { mode: "number" }).notNull().default(0),
    lastCopiedTable: text("last_copied_table"),
    isActive: boolean("is_active").notNull().default(true),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_org_relocation_active")
      .on(table.organizationId)
      .where(sql`is_active = true`),
    index("idx_org_relocations_org_state").on(
      table.organizationId,
      table.currentState,
    ),
    index("idx_org_relocations_state_started").on(
      table.currentState,
      table.startedAt,
    ),
  ],
);

export const organizationRelocationChecksums = pgTable(
  "organization_relocation_checksums",
  {
    checksumId: bigint("checksum_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    relocationId: bigint("relocation_id", { mode: "number" })
      .references(() => organizationRelocations.relocationId, { onDelete: "cascade" })
      .notNull(),
    scopeKind: relocationChecksumScopeEnum("scope_kind").notNull(),
    scopeName: text("scope_name").notNull(),
    sourceDigest: text("source_digest").notNull(),
    targetDigest: text("target_digest").notNull(),
    matched: boolean("matched").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_relocation_checksums_relocation").on(
      table.relocationId,
      table.scopeKind,
    ),
    index("idx_relocation_checksums_mismatches").on(
      table.relocationId,
      table.matched,
    ),
  ],
);

export const organizationCellTraffic = pgTable(
  "organization_cell_traffic",
  {
    orgId: text("org_id").notNull(),
    cellId: text("cell_id").notNull(),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.cellId] })],
);
