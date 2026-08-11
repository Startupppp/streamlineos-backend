import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
  decimal,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";
import { contacts, crmOrganizations } from "../crm/contacts";
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

export const feedbucketWidgets = pgTable(
  "feedbucket_widgets",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
    managedProductId: integer("managed_product_id").references(() => managedProducts.managedProductId, { onDelete: "set null" }),
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
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("uniq_feedbucket_widgets_public_key").on(t.publicKey),
    index("idx_feedbucket_widgets_org").on(t.orgId, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_widgets_managed_product").on(t.orgId, t.managedProductId).where(sql`deleted_at IS NULL`),
    unique("uniq_feedbucket_widgets_org_id").on(t.orgId, t.id),
  ],
);

export const feedbucketSubmissions = pgTable(
  "feedbucket_submissions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    widgetId: integer("widget_id")
      .references(() => feedbucketWidgets.id, { onDelete: "cascade" })
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
    crmContactId: integer("crm_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    crmOrganizationId: integer("crm_organization_id").references(() => crmOrganizations.id, { onDelete: "set null" }),
    accountValueSnapshot: decimal("account_value_snapshot", { precision: 15, scale: 2 }),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
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
    index("idx_feedbucket_submissions_widget").on(t.orgId, t.widgetId, t.status, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_org_status").on(t.orgId, t.status, t.createdAt).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_assignee").on(t.orgId, t.assigneeId).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_crm_contact").on(t.orgId, t.crmContactId).where(sql`deleted_at IS NULL`),
    index("idx_feedbucket_submissions_crm_org").on(t.orgId, t.crmOrganizationId).where(sql`deleted_at IS NULL`),
    unique("uniq_feedbucket_submissions_org_id").on(t.orgId, t.id),
  ],
);

export const feedbucketAttachments = pgTable(
  "feedbucket_attachments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: integer("submission_id")
      .references(() => feedbucketSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    fileUrl: text("file_url").notNull(),
    fileKey: text("file_key"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
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
  managedProduct: one(managedProducts, { fields: [feedbucketWidgets.managedProductId], references: [managedProducts.managedProductId] }),
  creator: one(users, { fields: [feedbucketWidgets.createdBy], references: [users.id] }),
  submissions: many(feedbucketSubmissions),
}));

export const feedbucketSubmissionsRelations = relations(feedbucketSubmissions, ({ one, many }) => ({
  widget: one(feedbucketWidgets, {
    fields: [feedbucketSubmissions.widgetId],
    references: [feedbucketWidgets.id],
  }),
  assignee: one(users, { fields: [feedbucketSubmissions.assigneeId], references: [users.id] }),
  linkedTicket: one(tickets, {
    fields: [feedbucketSubmissions.linkedTicketId],
    references: [tickets.id],
  }),
  crmContact: one(contacts, { fields: [feedbucketSubmissions.crmContactId], references: [contacts.id] }),
  crmOrganization: one(crmOrganizations, { fields: [feedbucketSubmissions.crmOrganizationId], references: [crmOrganizations.id] }),
  attachments: many(feedbucketAttachments),
}));

export const feedbucketAttachmentsRelations = relations(feedbucketAttachments, ({ one }) => ({
  submission: one(feedbucketSubmissions, {
    fields: [feedbucketAttachments.submissionId],
    references: [feedbucketSubmissions.id],
  }),
}));
