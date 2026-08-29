import { pgTable, text, serial, timestamp, decimal, integer, bigint, date, boolean, jsonb, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { desc, relations, sql } from "drizzle-orm";
import {
  invReservationStrategyEnum, invCostingMethodEnum, invExpiryPolicyEnum,
  invIdempotencyStatusEnum, invJobStatusEnum, invWebhookEventStatusEnum,
  invReasonCategoryEnum, invImportRowStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";

export const invSettings = pgTable("inv_settings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull().unique(),
  allowNegativeStock: boolean("allow_negative_stock").default(false).notNull(),
  allowBackorders: boolean("allow_backorders").default(false).notNull(),
  reservationStrategy: invReservationStrategyEnum("reservation_strategy").default("AUTO_ON_CONFIRM").notNull(),
  defaultCostingMethod: invCostingMethodEnum("default_costing_method").default("WEIGHTED_AVERAGE").notNull(),
  expiryReservationPolicy: invExpiryPolicyEnum("expiry_reservation_policy").default("BLOCK").notNull(),
  inspectionOnReceipt: boolean("inspection_on_receipt").default(false).notNull(),
  inspectionOnReturn: boolean("inspection_on_return").default(false).notNull(),
  overReceiptTolerancePct: decimal("over_receipt_tolerance_pct", { precision: 5, scale: 2 }).default("0").notNull(),
  requirePoApproval: boolean("require_po_approval").default(false).notNull(),
  /**
   * INV-309. Above this order value a purchase order needs sign-off. Null means
   * the boolean above decides, which is every order or none — and "every order"
   * is how an approval policy ends up switched off entirely.
   */
  poApprovalThreshold: decimal("po_approval_threshold", { precision: 18, scale: 4 }),
  adjustmentApprovalThreshold: decimal("adjustment_approval_threshold", { precision: 18, scale: 4 }),
  adjustmentApprovalValueThreshold: decimal("adjustment_approval_value_threshold", { precision: 18, scale: 4 }),
  autoReserveOnConfirm: boolean("auto_reserve_on_confirm").default(true).notNull(),
  allowPartialShipment: boolean("allow_partial_shipment").default(true).notNull(),
  packageRequiredForShipping: boolean("package_required_for_shipping").default(false).notNull(),
  channelPublishPolicy: text("channel_publish_policy"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_settings_org_id").on(table.orgId, table.id),
  index("idx_inv_settings_org").on(table.orgId),
]);

export const invReasonCodes = pgTable("inv_reason_codes", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  label: text("label").notNull(),
  category: invReasonCategoryEnum("category").default("ADJUSTMENT").notNull(),
  requiresApproval: boolean("requires_approval").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_reason_codes_org_code").on(table.orgId, table.code),
  unique("uniq_inv_reason_codes_org_id").on(table.orgId, table.id),
  index("idx_inv_reason_codes_org_category").on(table.orgId, table.category),
]);

export const invReasonCodesRelations = relations(invReasonCodes, ({ one }) => ({
  organization: one(organizations, { fields: [invReasonCodes.orgId], references: [organizations.id] }),
}));

export const invNumberSequences = pgTable("inv_number_sequences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  docType: text("doc_type").notNull(),
  prefix: text("prefix").notNull(),
  nextNumber: integer("next_number").default(1).notNull(),
  padding: integer("padding").default(5).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_numseq_org_doctype").on(table.orgId, table.docType),
  unique("uniq_inv_number_sequences_org_id").on(table.orgId, table.id),
]);

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
  index("idx_inv_webhooks_org").on(table.orgId),
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

export const invAuditEvents = pgTable("inv_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actorUserId: text("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_audit_events_org_id").on(table.orgId, table.id),
  index("idx_inv_audit_org_type_created").on(table.orgId, table.resourceType, table.createdAt),
  // G1. Same keyset as the ledger's, for the same reason: one posting writes
  // several audit rows in one transaction, so `created_at` alone repeats and a
  // cursor on it would skip or duplicate at every page boundary.
  // Supersedes `idx_inv_audit_org_created`, which was its exact prefix.
  index("idx_inv_audit_org_created_id").on(table.orgId, desc(table.createdAt), desc(table.id)),
]);

export const invSettingsRelations = relations(invSettings, ({ one }) => ({
  organization: one(organizations, { fields: [invSettings.orgId], references: [organizations.id] }),
}));

export const invNumberSequencesRelations = relations(invNumberSequences, ({ one }) => ({
  organization: one(organizations, { fields: [invNumberSequences.orgId], references: [organizations.id] }),
}));

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

export const invAuditEventsRelations = relations(invAuditEvents, ({ one }) => ({
  organization: one(organizations, { fields: [invAuditEvents.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [invAuditEvents.actorUserId], references: [users.id] }),
}));

/**
 * D7. A taken audit export, as a manifest rather than a blob.
 *
 * The body is never stored: it is a deterministic function of the pinned
 * evidence version, the resolved warehouse scope and the date filters, all of
 * which are columns here, so `download` re-derives byte-identical output on
 * demand and an organisation's whole ledger never has to fit in a text column
 * the way `inv_export_jobs.result_url` requires.
 *
 * `pinned_xmax` is the transaction id boundary observed when the ceilings were
 * read. `serial` hands out ids before commit, so a lower id can still commit
 * after a higher one is visible; until `pg_snapshot_xmin(pg_current_snapshot())`
 * has passed this value, the set of rows at or below the ceilings can still
 * grow and no checksum over it would be reproducible.
 */
export const invAuditExportJobs = pgTable("inv_audit_export_jobs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  status: invJobStatusEnum("status").default("PENDING").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  evidenceVersion: text("evidence_version").notNull(),
  ledgerCeilingId: integer("ledger_ceiling_id").notNull(),
  auditCeilingId: integer("audit_ceiling_id").notNull(),
  pinnedXmax: decimal("pinned_xmax", { precision: 20, scale: 0 }).notNull(),
  /** `null` means the creator held the org-wide warehouse scope. */
  scopeWarehouseIds: jsonb("scope_warehouse_ids").$type<number[]>(),
  sections: jsonb("sections").$type<string[]>().notNull(),
  filterFrom: date("filter_from"),
  filterTo: date("filter_to"),
  ledgerRowCount: integer("ledger_row_count"),
  auditRowCount: integer("audit_row_count"),
  /** Lowercase hex SHA-256 of the whole document, set once the job completes. */
  checksum: text("checksum"),
  byteLength: bigint("byte_length", { mode: "number" }),
  settledAt: timestamp("settled_at"),
  failureReason: text("failure_reason"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_audit_export_jobs_org_id").on(table.orgId, table.id),
  index("idx_inv_audit_export_jobs_org_created").on(table.orgId, table.createdAt),
  index("idx_inv_audit_export_jobs_org_status").on(table.orgId, table.status),
]);

export const invAuditExportJobsRelations = relations(invAuditExportJobs, ({ one }) => ({
  organization: one(organizations, { fields: [invAuditExportJobs.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invAuditExportJobs.createdBy], references: [users.id] }),
}));
