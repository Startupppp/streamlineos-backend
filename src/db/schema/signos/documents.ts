import { pgTable, serial, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { signConversionStatusEnum } from "./enums";
import { signEnvelopes } from "./envelopes";

export const signDocuments = pgTable(
  "sign_documents",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "cascade" }).notNull(),
    originalFileKey: text("original_file_key").notNull(),
    currentFileKey: text("current_file_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    pageCount: integer("page_count"),
    fileSize: integer("file_size").notNull(),
    sha256Hash: text("sha256_hash").notNull(),
    conversionStatus: signConversionStatusEnum("conversion_status").default("not_needed").notNull(),
    conversionError: text("conversion_error"),
    orderIndex: integer("order_index").default(0).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_documents_org_envelope").on(table.orgId, table.envelopeId),
    unique("uniq_sign_documents_org_id").on(table.orgId, table.id),
  ],
);

export const signDocumentsRelations = relations(signDocuments, ({ one }) => ({
  organization: one(organizations, { fields: [signDocuments.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signDocuments.envelopeId], references: [signEnvelopes.id] }),
}));
