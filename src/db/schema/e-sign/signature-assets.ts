import { foreignKey, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { signSignatureAssetTypeEnum, signSignatureMethodEnum } from "./enums";
import { signEnvelopes } from "./envelopes";
import { signRecipients } from "./recipients";

export const signSignatureAssets = pgTable(
  "sign_signature_assets",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").notNull(),
    recipientId: integer("recipient_id").notNull(),
    assetType: signSignatureAssetTypeEnum("asset_type").notNull(),
    method: signSignatureMethodEnum("method").notNull(),
    imageFileKey: text("image_file_key"),
    typedText: text("typed_text"),
    typedFontStyle: text("typed_font_style"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.envelopeId], foreignColumns: [signEnvelopes.orgId, signEnvelopes.id], name: "fk_sign_signature_assets_envelope_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.recipientId], foreignColumns: [signRecipients.orgId, signRecipients.id], name: "fk_sign_signature_assets_recipient_id_org" }).onDelete("cascade"),
    index("idx_sign_signature_assets_recipient").on(table.recipientId),
    index("idx_sign_signature_assets_org_envelope").on(table.orgId, table.envelopeId),
    unique("uniq_sign_signature_assets_org_id").on(table.orgId, table.id),
  ],
);

export const signSignatureAssetsRelations = relations(signSignatureAssets, ({ one }) => ({
  organization: one(organizations, { fields: [signSignatureAssets.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signSignatureAssets.envelopeId], references: [signEnvelopes.id] }),
  recipient: one(signRecipients, { fields: [signSignatureAssets.recipientId], references: [signRecipients.id] }),
}));
