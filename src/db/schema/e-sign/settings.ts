import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";

// One row per tenant. Everything here is a default that lower layers (template, envelope)
// may override — nothing about SignOS behavior should be hardcoded outside this table.
export const signOrgSettings = pgTable(
  "sign_org_settings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),

    defaultExpirationDays: integer("default_expiration_days").default(30).notNull(),
    expirationWarningDays: integer("expiration_warning_days").default(3).notNull(),
    defaultReminderFirstAfterDays: integer("default_reminder_first_after_days").default(3).notNull(),
    defaultReminderRepeatDays: integer("default_reminder_repeat_days").default(3).notNull(),
    defaultReminderMaxCount: integer("default_reminder_max_count").default(5).notNull(),

    allowedFileTypes: jsonb("allowed_file_types").$type<string[]>().default(["application/pdf"]).notNull(),
    maxFileSizeMb: integer("max_file_size_mb").default(25).notNull(),
    allowedAuthMethods: jsonb("allowed_auth_methods").$type<string[]>()
      .default(["email_link", "access_code", "otp_email"]).notNull(),

    certificateFormat: text("certificate_format").default("pdf").notNull(),
    retentionPolicyJson: jsonb("retention_policy_json").$type<Record<string, unknown>>().default({}).notNull(),

    bulkSendMaxRowsPerJob: integer("bulk_send_max_rows_per_job").default(500).notNull(),
    bulkSendMaxActiveJobs: integer("bulk_send_max_active_jobs").default(5).notNull(),
    bulkSendMaxRecipientsPerEnvelope: integer("bulk_send_max_recipients_per_envelope").default(20).notNull(),
    senderRateLimitPerHour: integer("sender_rate_limit_per_hour").default(200).notNull(),

    brandingJson: jsonb("branding_json").$type<{
      logoUrl?: string;
      emailSenderName?: string;
      emailAccentColor?: string;
      signingPageLogoUrl?: string;
      signingPageSupportText?: string;
      completionMessage?: string;
      disclosureText?: string;
      disclosureVersion?: string;
    }>().default({}).notNull(),

    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_sign_org_settings_org").on(table.orgId),
    unique("uniq_sign_org_settings_org_id").on(table.orgId, table.id),
  ],
);

export const signOrgSettingsRelations = relations(signOrgSettings, ({ one }) => ({
  organization: one(organizations, { fields: [signOrgSettings.orgId], references: [organizations.id] }),
}));
