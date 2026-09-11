/**
 * The machinery that carries work across the module's boundary.
 *
 * An idempotency fence so a retried command is not applied twice, import and
 * export jobs with their per-row outcomes so a resumed import skips what already
 * applied, and outbound webhooks with their subscriptions and delivery attempts.
 * Four tables that look unrelated until you notice they all exist because the
 * other side of the call can fail or repeat: none of them holds inventory, they
 * hold the state that makes talking about inventory survivable.
 */

import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invIdempotencyStatusEnum, invJobStatusEnum, invWebhookEventStatusEnum, invImportRowStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

export const invIdempotencyKeys = pgTable("inv_idempotency_keys", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash"),
  status: invIdempotencyStatusEnum("status").default("IN_FLIGHT").notNull(),
  response: jsonb("response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at"),
}, (table) => [
  uniqueIndex("uniq_inv_idempotency_org_key").on(table.orgId, table.idempotencyKey),
  unique("uniq_inv_idempotency_keys_org_id").on(table.orgId, table.id),
  index("idx_inv_idempotency_expires").on(table.expiresAt),
  index("idx_inv_idempotency_lease_expires").on(table.leaseExpiresAt),
]);

export const invImportJobs = pgTable("inv_import_jobs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobType: text("job_type").notNull(),
  status: invJobStatusEnum("status").default("PENDING").notNull(),
  fileName: text("file_name"),
  totalRows: integer("total_rows").default(0).notNull(),
  processedRows: integer("processed_rows").default(0).notNull(),
  errorRows: integer("error_rows").default(0).notNull(),
  errors: jsonb("errors"),
  resultUrl: text("result_url"),
  /** Of the uploaded file, so the same file finds the job it already made. */
  checksum: text("checksum"),
  idempotencyKey: text("idempotency_key"),
  chunkSize: integer("chunk_size").default(500).notNull(),
  /** The resume point: rows below it have an outcome, rows at or above do not. */
  nextRow: integer("next_row").default(0).notNull(),
  stagedRows: integer("staged_rows").default(0).notNull(),
  cancelledAt: timestamp("cancelled_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_import_jobs_org_id").on(table.orgId, table.id),
  index("idx_inv_import_org_status").on(table.orgId, table.status),
  uniqueIndex("uniq_inv_import_jobs_org_idempotency").on(table.orgId, table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

/**
 * Staged import rows.
 *
 * The importer used to take rows in the request body and apply them inside the
 * request transaction, so a 100,000-row file could not be expressed and a
 * failure at row 9,000 lost everything before it. Rows land here first; the
 * processor walks them in chunks, and per-row status is what lets a re-run skip
 * what already applied instead of posting it twice.
 */
export const invImportRows = pgTable("inv_import_rows", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobId: integer("job_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  payload: jsonb("payload").$type<Record<string, string>>().notNull(),
  status: invImportRowStatusEnum("status").default("PENDING").notNull(),
  errorCode: text("error_code"),
  errorField: text("error_field"),
  errorMessage: text("error_message"),
  appliedAt: timestamp("applied_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_import_rows_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.jobId],
    foreignColumns: [invImportJobs.orgId, invImportJobs.id],
    name: "fk_inv_import_rows_job_id_org",
  }).onDelete("cascade"),
  uniqueIndex("uniq_inv_import_rows_job_row").on(table.orgId, table.jobId, table.rowNumber),
  index("idx_inv_import_rows_job_status_row").on(table.orgId, table.jobId, table.status, table.rowNumber),
]);

export const invExportJobs = pgTable("inv_export_jobs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobType: text("job_type").notNull(),
  status: invJobStatusEnum("status").default("PENDING").notNull(),
  fileName: text("file_name"),
  totalRows: integer("total_rows").default(0).notNull(),
  processedRows: integer("processed_rows").default(0).notNull(),
  errorRows: integer("error_rows").default(0).notNull(),
  errors: jsonb("errors"),
  resultUrl: text("result_url"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_export_jobs_org_id").on(table.orgId, table.id),
  index("idx_inv_export_org_status").on(table.orgId, table.status),
]);

export const invWebhooks = pgTable("inv_webhooks", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  events: jsonb("events").$type<string[]>().notNull(),
  secret: text("secret").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  lastDeliveryAt: timestamp("last_delivery_at"),
  lastDeliveryStatus: text("last_delivery_status"),
  /**
   * E7. Health of the endpoint, in *dead-lettered events* rather than in failed
   * attempts: one dead letter already means this URL refused every attempt over
   * the whole retry window, so counting attempts would disable a subscriber for a
   * single bad afternoon.
   *
   * `alertedAt` is what makes "alert before disable" a property of the data and
   * not of the order two statements happen to run in — it is stamped at the alert
   * threshold and the disable threshold is strictly higher, so a webhook can never
   * be disabled without an alert row already existing. All three reset on the next
   * successful delivery.
   */
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  failingSince: timestamp("failing_since"),
  alertedAt: timestamp("alerted_at"),
  disabledAt: timestamp("disabled_at"),
  disabledReason: text("disabled_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_webhooks_org_id").on(table.orgId, table.id),
]);

export const invWebhookEvents = pgTable("inv_webhook_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  webhookId: integer("webhook_id").references(() => invWebhooks.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  /**
   * E7. `status` carries three meanings and no fourth was added, because the
   * `inv_webhook_event_status` pgEnum is also the frontend's union and a new label
   * cannot be used in the transaction that adds it (drizzle runs every pending
   * migration in one):
   *
   *   PENDING   — queued or between retries; `nextAttemptAt` says when it is due
   *   DELIVERED — a 2xx was received
   *   FAILED    — terminal. `deadLetteredAt` is set and no worker will pick it up
   *
   * So "is it dead-lettered" is `deadLetteredAt is not null`, never a status probe.
   */
  status: invWebhookEventStatusEnum("status").default("PENDING").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  deliveredAt: timestamp("delivered_at"),
  /**
   * The producing outbox event id. Delivery is at-least-once by construction — the
   * publisher marks an outbox row DELIVERED in a transaction separate from the one
   * that ran the consumer — so a crash in between replays the emit. Unique per
   * (org, webhook), this turns that replay into a no-op instead of a second
   * customer-visible webhook.
   */
  dedupeKey: text("dedupe_key"),
  nextAttemptAt: timestamp("next_attempt_at"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  lastAttemptAt: timestamp("last_attempt_at"),
  lastError: text("last_error"),
  deadLetteredAt: timestamp("dead_lettered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_webhook_events_org_id").on(table.orgId, table.id),
  index("idx_inv_whe_org_status").on(table.orgId, table.status),
  uniqueIndex("uniq_inv_whe_org_webhook_dedupe")
    .on(table.orgId, table.webhookId, table.dedupeKey)
    .where(sql`dedupe_key is not null`),
  index("idx_inv_whe_due")
    .on(table.orgId, table.nextAttemptAt)
    .where(sql`status = 'PENDING'`),
  index("idx_inv_whe_dead")
    .on(table.orgId, table.deadLetteredAt)
    .where(sql`dead_lettered_at is not null`),
]);

export const invIdempotencyKeysRelations = relations(invIdempotencyKeys, ({ one }) => ({
  organization: one(organizations, { fields: [invIdempotencyKeys.orgId], references: [organizations.id] }),
}));

export const invImportJobsRelations = relations(invImportJobs, ({ one }) => ({
  organization: one(organizations, { fields: [invImportJobs.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invImportJobs.createdBy], references: [users.id] }),
}));

export const invExportJobsRelations = relations(invExportJobs, ({ one }) => ({
  organization: one(organizations, { fields: [invExportJobs.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invExportJobs.createdBy], references: [users.id] }),
}));

export const invWebhookEventSubscriptions = pgTable("inv_webhook_event_subscriptions", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  webhookId: integer("webhook_id").notNull(),
  eventType: text("event_type").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_inv_webhook_event_subs_key").on(table.orgId, table.webhookId, table.eventType),
  unique("uniq_inv_webhook_event_subs_org_id").on(table.orgId, table.id),
  index("idx_inv_webhook_event_subs_dispatch").on(table.orgId, table.eventType),
  foreignKey({
    columns: [table.orgId, table.webhookId],
    foreignColumns: [invWebhooks.orgId, invWebhooks.id],
    name: "fk_inv_webhook_event_subs_org_webhook",
  }).onDelete("cascade"),
]);

export const invWebhookEventSubscriptionsRelations = relations(invWebhookEventSubscriptions, ({ one }) => ({
  organization: one(organizations, { fields: [invWebhookEventSubscriptions.orgId], references: [organizations.id] }),
  webhook: one(invWebhooks, { fields: [invWebhookEventSubscriptions.webhookId], references: [invWebhooks.id] }),
}));

export const invWebhooksRelations = relations(invWebhooks, ({ one, many }) => ({
  organization: one(organizations, { fields: [invWebhooks.orgId], references: [organizations.id] }),
  events: many(invWebhookEvents),
}));

export const invWebhookEventsRelations = relations(invWebhookEvents, ({ one }) => ({
  organization: one(organizations, { fields: [invWebhookEvents.orgId], references: [organizations.id] }),
  webhook: one(invWebhooks, { fields: [invWebhookEvents.webhookId], references: [invWebhooks.id] }),
}));
