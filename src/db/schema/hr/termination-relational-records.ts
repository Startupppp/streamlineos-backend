import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { terminations } from "./offboarding";

export const terminationReasons = pgTable(
  "termination_reasons",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    terminationReasonId: bigint("termination_reason_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    terminationId: integer("termination_id").notNull(),
    reason: text("reason").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_termination_reasons",
      columns: [table.organizationId, table.terminationReasonId],
    }),
    unique("uniq_termination_reasons_parent_reason").on(
      table.organizationId,
      table.terminationId,
      table.reason,
    ),
    unique("uniq_termination_reasons_parent_order").on(
      table.organizationId,
      table.terminationId,
      table.sortOrder,
    ),
    index("idx_termination_reasons_parent").on(
      table.organizationId,
      table.terminationId,
      table.sortOrder,
    ),
    foreignKey({
      name: "fk_termination_reasons_parent",
      columns: [table.organizationId, table.terminationId],
      foreignColumns: [terminations.orgId, terminations.id],
    }).onDelete("cascade"),
    check(
      "chk_termination_reasons_value",
      sql`btrim(${table.reason}) <> '' AND ${table.sortOrder} >= 0`,
    ),
  ],
);

export const terminationSupportingDocuments = pgTable(
  "termination_supporting_documents",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    terminationSupportingDocumentId: bigint("termination_supporting_document_id", {
      mode: "bigint",
    })
      .generatedAlwaysAsIdentity()
      .notNull(),
    terminationId: integer("termination_id").notNull(),
    legacyUrl: text("legacy_url").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_termination_supporting_documents",
      columns: [table.organizationId, table.terminationSupportingDocumentId],
    }),
    unique("uniq_termination_supporting_documents_url").on(
      table.organizationId,
      table.terminationId,
      table.legacyUrl,
    ),
    unique("uniq_termination_supporting_documents_order").on(
      table.organizationId,
      table.terminationId,
      table.sortOrder,
    ),
    index("idx_termination_supporting_documents_parent").on(
      table.organizationId,
      table.terminationId,
      table.sortOrder,
    ),
    foreignKey({
      name: "fk_termination_supporting_documents_parent",
      columns: [table.organizationId, table.terminationId],
      foreignColumns: [terminations.orgId, terminations.id],
    }).onDelete("cascade"),
    check(
      "chk_termination_supporting_documents_value",
      sql`btrim(${table.legacyUrl}) <> '' AND ${table.sortOrder} >= 0`,
    ),
  ],
);
