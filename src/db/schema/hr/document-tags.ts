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
import { documents } from "./documents";

export const hrDocumentTags = pgTable(
  "hr_document_tags",
  {
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    documentTagId: bigint("document_tag_id", { mode: "bigint" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    documentId: integer("document_id").notNull(),
    tag: text("tag").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_hr_document_tags",
      columns: [table.organizationId, table.documentTagId],
    }),
    unique("uniq_hr_document_tags_parent_tag").on(
      table.organizationId,
      table.documentId,
      table.tag,
    ),
    unique("uniq_hr_document_tags_parent_order").on(
      table.organizationId,
      table.documentId,
      table.sortOrder,
    ),
    index("idx_hr_document_tags_lookup").on(table.organizationId, table.tag),
    foreignKey({
      name: "fk_hr_document_tags_parent",
      columns: [table.organizationId, table.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }).onDelete("cascade"),
    check(
      "chk_hr_document_tags_value",
      sql`btrim(${table.tag}) <> '' AND ${table.sortOrder} >= 0`,
    ),
  ],
);
