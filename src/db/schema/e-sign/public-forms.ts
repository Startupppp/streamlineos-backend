import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { signPublicFormStatusEnum } from "./enums";
import { signTemplates } from "./templates";

export const signPublicForms = pgTable(
  "sign_public_forms",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    templateId: integer("template_id").references(() => signTemplates.id, { onDelete: "cascade" }).notNull(),
    slug: text("slug").notNull(),
    status: signPublicFormStatusEnum("status").default("draft").notNull(),
    accessCodeHash: text("access_code_hash"),
    maxSubmissions: integer("max_submissions"),
    submissionCount: integer("submission_count").default(0).notNull(),
    expiresAt: timestamp("expires_at"),
    completionRedirectUrl: text("completion_redirect_url"),
    webhookUrl: text("webhook_url"),
    embedAllowed: boolean("embed_allowed").default(false).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_sign_public_forms_slug").on(table.slug),
    index("idx_sign_public_forms_org_status").on(table.orgId, table.status),
    unique("uniq_sign_public_forms_org_id").on(table.orgId, table.id),
  ],
);

export const signPublicFormsRelations = relations(signPublicForms, ({ one }) => ({
  organization: one(organizations, { fields: [signPublicForms.orgId], references: [organizations.id] }),
  template: one(signTemplates, { fields: [signPublicForms.templateId], references: [signTemplates.id] }),
}));
