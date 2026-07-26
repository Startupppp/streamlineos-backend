import { pgTable, text, serial, timestamp, decimal, integer, boolean, jsonb, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  invReservationStrategyEnum, invCostingMethodEnum, invExpiryPolicyEnum,
  invIdempotencyStatusEnum, invJobStatusEnum, invWebhookEventStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";

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
  adjustmentApprovalThreshold: decimal("adjustment_approval_threshold", { precision: 18, scale: 4 }),
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
}, (table) => [
  uniqueIndex("uniq_inv_idempotency_org_key").on(table.orgId, table.idempotencyKey),
  unique("uniq_inv_idempotency_keys_org_id").on(table.orgId, table.id),
  index("idx_inv_idempotency_expires").on(table.expiresAt),
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
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_import_jobs_org_id").on(table.orgId, table.id),
  index("idx_inv_import_org_status").on(table.orgId, table.status),
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
  status: invWebhookEventStatusEnum("status").default("PENDING").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_webhook_events_org_id").on(table.orgId, table.id),
  index("idx_inv_whe_org_status").on(table.orgId, table.status),
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
  index("idx_inv_audit_org_created").on(table.orgId, table.createdAt),
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
