import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { signEnvelopes } from "./envelopes";

// Immutable once written. Regeneration must go through an explicit admin/legal recovery
// flow (new row + audit event), never an in-place update of an existing certificate.
export const signCertificates = pgTable(
  "sign_certificates",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "cascade" }).notNull(),
    certificateNumber: text("certificate_number").notNull(),
    certificateFileKey: text("certificate_file_key").notNull(),
    finalPdfFileKey: text("final_pdf_file_key").notNull(),
    finalPdfHash: text("final_pdf_hash").notNull(),
    watermarked: boolean("watermarked").default(false).notNull(),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    certificateJson: jsonb("certificate_json").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_sign_certificates_number").on(table.certificateNumber),
    index("idx_sign_certificates_org_envelope").on(table.orgId, table.envelopeId),
    unique("uniq_sign_certificates_org_id").on(table.orgId, table.id),
  ],
);

export const signCertificatesRelations = relations(signCertificates, ({ one }) => ({
  organization: one(organizations, { fields: [signCertificates.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signCertificates.envelopeId], references: [signEnvelopes.id] }),
}));
