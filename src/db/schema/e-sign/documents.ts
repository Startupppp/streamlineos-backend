import { pgTable, serial, text, integer, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { signConversionStatusEnum } from "./enums";
import { signEnvelopes } from "./envelopes";

export const signDocuments = pgTable(
  "sign_documents",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").notNull(),
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
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.envelopeId], foreignColumns: [signEnvelopes.orgId, signEnvelopes.id], name: "fk_sign_documents_envelope_id_org" }).onDelete("cascade"),
    index("idx_sign_documents_org_envelope").on(table.orgId, table.envelopeId),
    unique("uniq_sign_documents_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_sign_doc_org_created_mbr",
    }).onDelete("set null"),
  ],
);

export const signDocumentsRelations = relations(signDocuments, ({ one }) => ({
  organization: one(organizations, { fields: [signDocuments.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signDocuments.envelopeId], references: [signEnvelopes.id] }),
}));
