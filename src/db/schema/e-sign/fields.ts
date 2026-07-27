import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { signFieldTypeEnum } from "./enums";
import { signEnvelopes } from "./envelopes";
import { signDocuments } from "./documents";
import { signRecipients } from "./recipients";

export const signFields = pgTable(
  "sign_fields",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "cascade" }).notNull(),
    documentId: integer("document_id").references(() => signDocuments.id, { onDelete: "cascade" }).notNull(),
    recipientId: integer("recipient_id").references(() => signRecipients.id, { onDelete: "cascade" }).notNull(),
    fieldType: signFieldTypeEnum("field_type").notNull(),
    label: text("label"),
    pageNumber: integer("page_number").notNull(),
    // Coordinates are in PDF points, relative to the page's top-left corner (not viewport
    // pixels, not bottom-left PDF space) — the PDF stamping engine flips y against the
    // actual page height read from the source PDF at render time.
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    required: boolean("required").default(false).notNull(),
    readonly: boolean("readonly").default(false).notNull(),
    orderIndex: integer("order_index").default(0).notNull(),
    // Ties radio buttons that belong to the same group together.
    groupId: text("group_id"),
    defaultValue: text("default_value"),
    optionsJson: jsonb("options_json").$type<string[]>(),
    validationType: text("validation_type"),
    validationRulesJson: jsonb("validation_rules_json").$type<Record<string, unknown>>(),
    conditionalRulesJson: jsonb("conditional_rules_json").$type<Record<string, unknown>>(),
    valueJson: jsonb("value_json").$type<Record<string, unknown>>(),
    attachmentFileKey: text("attachment_file_key"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_fields_org_envelope").on(table.orgId, table.envelopeId),
    index("idx_sign_fields_document").on(table.documentId),
    index("idx_sign_fields_recipient").on(table.recipientId),
    unique("uniq_sign_fields_org_id").on(table.orgId, table.id),
  ],
);

export const signFieldsRelations = relations(signFields, ({ one }) => ({
  organization: one(organizations, { fields: [signFields.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signFields.envelopeId], references: [signEnvelopes.id] }),
  document: one(signDocuments, { fields: [signFields.documentId], references: [signDocuments.id] }),
  recipient: one(signRecipients, { fields: [signFields.recipientId], references: [signRecipients.id] }),
}));
