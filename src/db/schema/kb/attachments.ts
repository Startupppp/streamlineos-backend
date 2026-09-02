import {
  pgTable,
  bigint,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { kbPages } from "./pages";

export const kbPageAttachments = pgTable(
  "kb_page_attachments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id"),
    fileKey: text("file_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    sha256: text("sha256"),
    uploadedById: text("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("uniq_kb_page_attachments_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_kb_page_attachments_org_file_key").on(table.orgId, table.fileKey),
    index("idx_kb_page_attachments_org_page")
      .on(table.orgId, table.pageId, table.createdAt)
      .where(sql`deleted_at IS NULL`),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_attachments_org_page",
    }).onDelete("cascade"),
  ],
);
