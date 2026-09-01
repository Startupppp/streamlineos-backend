import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { signEnvelopeStatusEnum, signRoutingModeEnum, signCcTimingEnum } from "./enums";
import { signTemplates } from "./templates";
import { signWatermarkPolicies } from "./watermark";
import { signPublicForms } from "./public-forms";

export const signEnvelopes = pgTable(
  "sign_envelopes",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    subject: text("subject"),
    message: text("message"),
    status: signEnvelopeStatusEnum("status").default("draft").notNull(),
    routingMode: signRoutingModeEnum("routing_mode").default("parallel").notNull(),
    ccTiming: signCcTimingEnum("cc_timing").default("on_complete").notNull(),
    allowDecline: boolean("allow_decline").default(true).notNull(),
    sourceModule: text("source_module"),
    sourceEntityType: text("source_entity_type"),
    sourceEntityId: text("source_entity_id"),
    templateId: integer("template_id").references(() => signTemplates.id, { onDelete: "set null" }),
    watermarkPolicyId: integer("watermark_policy_id").references(() => signWatermarkPolicies.id, { onDelete: "set null" }),
    senderMembershipId: integer("sender_membership_id"),

    reminderEnabled: boolean("reminder_enabled").default(true).notNull(),
    reminderFirstAfterDays: integer("reminder_first_after_days").default(3).notNull(),
    reminderRepeatDays: integer("reminder_repeat_days").default(3).notNull(),
    reminderMaxCount: integer("reminder_max_count").default(5).notNull(),
    reminderSentCount: integer("reminder_sent_count").default(0).notNull(),
    lastReminderAt: timestamp("last_reminder_at"),

    expiresAt: timestamp("expires_at"),
    sentAt: timestamp("sent_at"),
    completedAt: timestamp("completed_at"),
    voidedAt: timestamp("voided_at"),
    voidedByMembershipId: integer("voided_by_membership_id"),
    voidReason: text("void_reason"),
    declinedAt: timestamp("declined_at"),
    correctionRequiredAt: timestamp("correction_required_at"),
    correctionReason: text("correction_reason"),

    finalizationKey: text("finalization_key"),
    finalizedAt: timestamp("finalized_at"),
    finalPdfFileKey: text("final_pdf_file_key"),
    finalPdfHash: text("final_pdf_hash"),

    publicFormId: integer("public_form_id").references(() => signPublicForms.id, { onDelete: "set null" }),

    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_envelopes_org_status").on(table.orgId, table.status),
    index("idx_sign_envelopes_org_sender").on(table.orgId, table.senderMembershipId),
    index("idx_sign_envelopes_source").on(table.sourceModule, table.sourceEntityType, table.sourceEntityId),
    index("idx_sign_envelopes_expires").on(table.expiresAt),
    uniqueIndex("uniq_sign_envelopes_finalization_key").on(table.finalizationKey),
    unique("uniq_sign_envelopes_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.senderMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_sign_env_org_sender_mbr",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.voidedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_sign_env_org_voided_mbr",
    }).onDelete("set null"),
  ],
);

export const signEnvelopesRelations = relations(signEnvelopes, ({ one }) => ({
  organization: one(organizations, { fields: [signEnvelopes.orgId], references: [organizations.id] }),
  senderMember: one(organizationMembers, {
    fields: [signEnvelopes.orgId, signEnvelopes.senderMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
  template: one(signTemplates, { fields: [signEnvelopes.templateId], references: [signTemplates.id] }),
  watermarkPolicy: one(signWatermarkPolicies, {
    fields: [signEnvelopes.watermarkPolicyId],
    references: [signWatermarkPolicies.id],
  }),
}));
