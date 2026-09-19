import {
  pgEnum,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  decimal,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";
import { managedProducts } from "./managed-products";

export interface FeedbucketAiAnalysis {
  type: "bug" | "feature" | "improvement" | "question" | "praise" | "other";
  confidence: number;
  suggestedTicketType: "EPIC" | "BUG" | "STORY" | "TASK";
  title: string;
  summary: string;
  description: string;
  reproductionSteps: string[];
  suggestions: string[];
  acceptanceCriteria: string[];
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  model: string;
  processedAt: string;
}

export interface FeedbucketMetadata {
  browser?: string;
  browserVersion?: string;
  os?: string;
  device?: string;
  screenW?: number;
  screenH?: number;
  viewportW?: number;
  viewportH?: number;
  userAgent?: string;
  language?: string;
  referrer?: string;
}

export interface FeedbucketConsoleEntry {
  level: string;
  message: string;
  ts?: number;
}

export interface FeedbucketNetworkEntry {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  startedAt: string;
  type: "xhr" | "fetch";
  ok: boolean;
  error?: string;
}

export interface FeedbucketWidgetTheme {
  color?: string;
  position?: "bottom-right" | "bottom-left";
  label?: string;
}

export type FeedbucketAssigneeRules = Partial<
  Record<"bug" | "idea" | "feature" | "question" | "praise" | "other", number>
>;

export const feedbucketSubmissionTypeEnum = pgEnum("feedbucket_submission_type", [
  "bug",
  "idea",
  "feature",
  "question",
  "praise",
  "other",
]);

export const feedbucketSubmissionStatusEnum = pgEnum("feedbucket_submission_status", [
  "open",
  "in_progress",
  "resolved",
  "archived",
]);

export const feedbucketSubmissionPriorityEnum = pgEnum("feedbucket_submission_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const feedbucketWidgets = build.table(
  "feedbucket_widgets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id"),
    managedProductId: integer("managed_product_id"),
    defaultProjectId: integer("default_project_id"),
    defaultAssigneeMembershipId: integer("default_assignee_membership_id"),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    allowedDomains: text("allowed_domains")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    autoCreateTicket: boolean("auto_create_ticket").notNull().default(false),
    defaultTicketType: text("default_ticket_type").notNull().default("BUG"),
    isActive: boolean("is_active").notNull().default(true),
    aiAssistEnabled: boolean("ai_assist_enabled").notNull().default(false),
    theme: jsonb("theme").$type<FeedbucketWidgetTheme>(),
    assigneeRules: jsonb("assignee_rules").$type<FeedbucketAssigneeRules>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.managedProductId], foreignColumns: [managedProducts.orgId, managedProducts.id], name: "fk_feedbucket_widgets_org_product" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_feedbucket_widgets_org_project" }).onDelete("set null"),
    uniqueIndex("uniq_feedbucket_widgets_public_key").on(t.publicKey),
    index("idx_feedbucket_widgets_org").on(t.orgId, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_widgets_managed_product").on(t.orgId, t.managedProductId).where(sql`deleted_at IS NULL`),
    unique("uniq_feedbucket_widgets_org_id").on(t.orgId, t.id),
  ],
);

export const feedbucketSubmissions = build.table(
  "feedbucket_submissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    widgetId: integer("widget_id")
      .notNull(),
    type: feedbucketSubmissionTypeEnum("type").notNull(),
    status: feedbucketSubmissionStatusEnum("status").notNull().default("open"),
    priority: feedbucketSubmissionPriorityEnum("priority"),
    message: text("message").notNull(),
    pageUrl: text("page_url"),
    screenshotUrl: text("screenshot_url"),
    screenshotKey: text("screenshot_key"),
    metadata: jsonb("metadata").$type<FeedbucketMetadata>(),
    consoleLogs: jsonb("console_logs").$type<FeedbucketConsoleEntry[]>(),
    networkLogs: jsonb("network_logs").$type<FeedbucketNetworkEntry[]>(),
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    crmContactId: integer("crm_contact_id"),
    crmOrganizationId: integer("crm_organization_id"),
    accountValueSnapshot: decimal("account_value_snapshot", { precision: 15, scale: 2 }),
    assigneeMembershipId: integer("assignee_membership_id"),
    linkedTicketId: integer("linked_ticket_id"),
    aiType: text("ai_type"),
    aiConfidence: integer("ai_confidence"),
    aiAnalysis: jsonb("ai_analysis").$type<FeedbucketAiAnalysis>(),
    aiModel: text("ai_model"),
    aiProcessedAt: timestamp("ai_processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.widgetId], foreignColumns: [feedbucketWidgets.orgId, feedbucketWidgets.id], name: "fk_feedbucket_submissions_org_widget" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.linkedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_feedbucket_submissions_org_ticket" }).onDelete("set null"),
    index("idx_feedbucket_submissions_widget").on(t.orgId, t.widgetId, t.status, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_org_status").on(t.orgId, t.status, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_assignee").on(t.orgId, t.assigneeMembershipId).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_crm_contact").on(t.orgId, t.crmContactId).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_crm_org").on(t.orgId, t.crmOrganizationId).where(sql`deleted_at IS NULL`),
    unique("uniq_feedbucket_submissions_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_feedbucket_submissions_assignee_actor",
      columns: [t.orgId, t.assigneeMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);

export const feedbucketAttachments = build.table(
  "feedbucket_attachments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: integer("submission_id")
      .notNull(),
    fileUrl: text("file_url").notNull(),
    fileKey: text("file_key"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.submissionId], foreignColumns: [feedbucketSubmissions.orgId, feedbucketSubmissions.id], name: "fk_feedbucket_attachments_org_submission" }).onDelete("cascade"),
    index("idx_feedbucket_attachments_submission").on(t.orgId, t.submissionId),
    unique("uniq_feedbucket_attachments_org_id").on(t.orgId, t.id),
  ],
);

export const feedbucketWidgetsRelations = relations(feedbucketWidgets, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [feedbucketWidgets.orgId],
    references: [organizations.id],
  }),
  project: one(projects, { fields: [feedbucketWidgets.projectId], references: [projects.id] }),
  managedProduct: one(managedProducts, { fields: [feedbucketWidgets.managedProductId], references: [managedProducts.id] }),
  creator: one(users, { fields: [feedbucketWidgets.createdBy], references: [users.id] }),
  submissions: many(feedbucketSubmissions),
}));

export const feedbucketSubmissionsRelations = relations(feedbucketSubmissions, ({ one, many }) => ({
  widget: one(feedbucketWidgets, {
    fields: [feedbucketSubmissions.widgetId],
    references: [feedbucketWidgets.id],
  }),
  linkedTicket: one(tickets, {
    fields: [feedbucketSubmissions.linkedTicketId],
    references: [tickets.id],
  }),
  attachments: many(feedbucketAttachments),
}));

export const feedbucketAttachmentsRelations = relations(feedbucketAttachments, ({ one }) => ({
  submission: one(feedbucketSubmissions, {
    fields: [feedbucketAttachments.submissionId],
    references: [feedbucketSubmissions.id],
  }),
}));
