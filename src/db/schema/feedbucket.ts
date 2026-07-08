import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "./auth";
import { projects } from "./projects/core";
import { tickets } from "./projects/tasks";

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

export interface FeedbucketWidgetTheme {
  color?: string;
  position?: "bottom-right" | "bottom-left";
  label?: string;
}

export const feedbucketSubmissionTypeEnum = pgEnum("feedbucket_submission_type", [
  "bug",
  "idea",
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
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    allowedDomains: text("allowed_domains")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    autoCreateTicket: boolean("auto_create_ticket").notNull().default(false),
    defaultTicketType: text("default_ticket_type").notNull().default("BUG"),
    isActive: boolean("is_active").notNull().default(true),
    theme: jsonb("theme").$type<FeedbucketWidgetTheme>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("uniq_feedbucket_widgets_public_key").on(t.publicKey),
    index("idx_feedbucket_widgets_org").on(t.orgId, t.createdAt),
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
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    linkedTicketId: integer("linked_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    index("idx_feedbucket_submissions_widget").on(t.orgId, t.widgetId, t.status, t.createdAt),
    index("idx_feedbucket_submissions_org_status").on(t.orgId, t.status, t.createdAt),
    index("idx_feedbucket_submissions_assignee").on(t.orgId, t.assigneeId),
  ],
);

export const feedbucketComments = pgTable(
  "feedbucket_comments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: integer("submission_id")
      .references(() => feedbucketSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("idx_feedbucket_comments_submission").on(t.orgId, t.submissionId, t.createdAt)],
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
  (t) => [index("idx_feedbucket_attachments_submission").on(t.orgId, t.submissionId)],
);

export const feedbucketWidgetsRelations = relations(feedbucketWidgets, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [feedbucketWidgets.orgId],
    references: [organizations.id],
  }),
  project: one(projects, { fields: [feedbucketWidgets.projectId], references: [projects.id] }),
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
  comments: many(feedbucketComments),
  attachments: many(feedbucketAttachments),
}));

export const feedbucketCommentsRelations = relations(feedbucketComments, ({ one }) => ({
  submission: one(feedbucketSubmissions, {
    fields: [feedbucketComments.submissionId],
    references: [feedbucketSubmissions.id],
  }),
  user: one(users, { fields: [feedbucketComments.userId], references: [users.id] }),
}));

export const feedbucketAttachmentsRelations = relations(feedbucketAttachments, ({ one }) => ({
  submission: one(feedbucketSubmissions, {
    fields: [feedbucketAttachments.submissionId],
    references: [feedbucketSubmissions.id],
  }),
}));
