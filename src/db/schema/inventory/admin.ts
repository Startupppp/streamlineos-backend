import { pgTable, text, serial, timestamp, decimal, integer, bigint, date, boolean, jsonb, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { desc, relations, sql } from "drizzle-orm";
import {
  invReservationStrategyEnum, invCostingMethodEnum, invExpiryPolicyEnum, invNearExpiryPolicyEnum,
  invIdempotencyStatusEnum, invJobStatusEnum, invWebhookEventStatusEnum,
  invImportRowStatusEnum, invGstModeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { clients } from "../crm/contacts";
import { invProductVariants } from "./core";
import { invLots } from "./traceability";
import { invStockReservations } from "./reservations";

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
  /**
   * E1 — the four packs, and which of them this organisation is running.
   *
   * A pack is a bundle of domain rules that only some organisations want: HSN
   * codes and tax treatment (`gst`), MRP and LASA handling (`pharmacy`), loose
   * versus packed selling units (`kirana`). Warehouse is the core product and is
   * on by default; the other three are off, because a field that is mandatory
   * for a pharmacy is noise for a distributor, and a validation rule nobody asked
   * for is a bug from the operator's side of the screen.
   *
   * Flags rather than a plan entitlement: these are how the organisation works,
   * not what it has paid for. Turning one off hides its navigation, its fields
   * and its validation — it does not delete the data already captured, so a pack
   * switched off and on again finds its rows intact.
   */
  packWarehouse: boolean("pack_warehouse").default(true).notNull(),
  packKirana: boolean("pack_kirana").default(false).notNull(),
  packPharmacy: boolean("pack_pharmacy").default(false).notNull(),
  packGst: boolean("pack_gst").default(false).notNull(),
  /**
   * NEO-2 — the quick-commerce pack: platform purchase orders, ASNs and
   * fill-rate. Off by default like every other optional pack, and off means the
   * ingest endpoint refuses before it parses anything.
   */
  packQuickCommerce: boolean("pack_quick_commerce").default(false).notNull(),
  /**
   * NEO-2 — Zepto's purchase orders arrive as email, not as an API call, so the
   * parser is heuristic in a way the JSON ones are not. It gets its own flag
   * because "we read a text file and believed it" is a decision an organisation
   * should make deliberately, not inherit from switching the pack on.
   */
  qcZeptoEmailPoEnabled: boolean("qc_zepto_email_po_enabled").default(false).notNull(),
  /**
   * NEO-2/NEO-12 — whether a delivery may be received without having been
   * announced. Off by default: most warehouses receive against a purchase order
   * and nothing else, and demanding an ASN they do not raise would stop
   * receiving altogether.
   */
  asnRequiredForGrn: boolean("asn_required_for_grn").default(false).notNull(),
  /**
   * NEO-14 - whether a newly reserved order may join a wave that is already open.
   *
   * Off by default, and that default is the safe one: a wave a picker is halfway
   * through is a physical walk they have planned, and adding a line to it behind
   * them is a change to work in progress. An organisation that wants order
   * streaming turns it on deliberately, having decided that a slightly longer
   * walk beats a second trip.
   */
  wavelessPicking: boolean("waveless_picking").default(false).notNull(),
  /**
   * The most lines a wave may reach by joining. A wave that grows without bound
   * is a picker who never finishes, which is the failure mode of every "just add
   * it to the current one" scheme.
   */
  wavelessMaxLines: integer("waveless_max_lines").default(50).notNull(),
  /**
   * D2 — short-dated stock is a different question from expired stock.
   *
   * `expiry_reservation_policy` decides whether an already-expired lot may be
   * promised at all. These two decide what happens to a lot that is still good
   * but close: `DEPRIORITIZE` keeps it allocatable and takes it last,
   * `BLOCK` refuses it automatically and leaves it for somebody holding
   * `inventory:allocation:override` to choose on purpose. The window is the same
   * one G3's expiry sweep notifies on, so "you were warned" and "the allocator
   * stopped offering it" line up instead of being two opinions about one lot.
   */
  nearExpiryPolicy: invNearExpiryPolicyEnum("near_expiry_policy").default("DEPRIORITIZE").notNull(),
  nearExpiryWindowDays: integer("near_expiry_window_days").default(30).notNull(),
  /**
   * E2 — how this organisation is registered, and therefore whether it may
   * collect tax from a customer at all.
   *
   * Lives beside the packs rather than on a document, because it is a property
   * of the registration and changes at most once or twice in a business's life.
   * Every outward line snapshots it anyway: a dealer that leaves the composition
   * scheme must not have last quarter's documents silently start claiming a tax
   * split they never showed.
   *
   * Only meaningful while `packGst` is on; an organisation not running the pack
   * keeps the default and nothing reads it.
   */
  gstMode: invGstModeEnum("gst_mode").default("REGULAR").notNull(),
  /**
   * E5 — the statutory adapters, each off until asked for.
   *
   * Separate from `packGst`, deliberately. The pack decides whether HSN codes
   * and tax treatment exist as *fields*; these decide whether this deployment
   * talks to an authority. An organisation capturing HSN for its own records and
   * filing through its accountant wants the first and not the second, and
   * collapsing them would sign it up for outbound traffic it never asked for.
   *
   * `*_ADAPTER` names which implementation answers. `stub` is the only one that
   * exists; anything else resolves to an adapter that refuses with
   * NO_CREDENTIALS rather than silently falling back, because a silent fallback
   * is how somebody comes to believe they are filing when they are rehearsing.
   */
  gstEinvoiceEnabled: boolean("gst_einvoice_enabled").default(false).notNull(),
  gstEwaybillEnabled: boolean("gst_ewaybill_enabled").default(false).notNull(),
  tallyExportEnabled: boolean("tally_export_enabled").default(false).notNull(),
  complianceAdapter: text("compliance_adapter").default("stub").notNull(),
  /**
   * E3 — the jurisdiction flag for the Schedule H1 register, default off.
   *
   * A bound H1 register is a legal obligation in some jurisdictions and not in
   * others, and it is not implied by running a pharmacy: a hospital store and a
   * retail chemist under the same roof answer to different rules. So it is its
   * own switch rather than something `packPharmacy` turns on, and it starts off
   * — a register that appears uninvited reads as a claim that this system keeps
   * one, which it does not.
   *
   * What it gates is an **export stub**. Inventory records stock movements, not
   * dispensings against a prescriber and a patient, so it cannot produce a
   * statutory register and does not pretend to: the export names the SKUs in
   * scope and states plainly that the dispensing rows are not held here. Turning
   * this on buys visibility of the scope, never compliance.
   */
  pharmacyH1RegisterEnabled: boolean("pharmacy_h1_register_enabled").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_settings_org_id").on(table.orgId, table.id),
  index("idx_inv_settings_org").on(table.orgId),
]);

/**
 * PEND-15. `inv_reason_codes` stood here and was dropped by `0589`.
 *
 * It arrived in 0407 to replace a fixed enum and nothing was ever built on it —
 * no service, no controller, no route, no foreign key. The only writer that ever
 * existed was 0407's own one-shot seed, so no organisation created since has had
 * a single row and none ever could; adjustments still record their reason as an
 * enum and a note. `inv_reason_category` is left in `enums.ts` deliberately:
 * dropping a type is a separate hazard for one line of catalogue, and 0545's
 * comment still names it.
 */

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

/**
 * E5 — what an adapter said, kept.
 *
 * One row per attempt at one statutory document, and the row is the audit: a tax
 * authority's acknowledgement is not something to reconstruct from a log line.
 * `raw_response` is stored verbatim rather than parsed into columns, because the
 * shape that matters in a dispute is the one the provider actually sent.
 *
 * `adapter_is_live` is on the row rather than derived from `adapter_code` at
 * read time. A deployment that later configures a real GSP must not retroactively
 * make its rehearsals look like filings, and a column written at the time is the
 * only thing that survives that change.
 *
 * Uniqueness is on `(org_id, kind, source_type, source_id, payload_hash)`: the
 * same document registered twice is one filing, and a document *edited* and
 * re-registered is a different hash and therefore a different row — which is
 * what stops an amended invoice silently inheriting the original's IRN.
 */
export const invComplianceDocuments = pgTable("inv_compliance_documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  kind: text("kind").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  documentNumber: text("document_number").notNull(),
  payloadHash: text("payload_hash").notNull(),
  adapterCode: text("adapter_code").notNull(),
  adapterIsLive: boolean("adapter_is_live").default(false).notNull(),
  status: text("status").notNull(),
  externalId: text("external_id"),
  acknowledgedAt: timestamp("acknowledged_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  attempts: integer("attempts").default(0).notNull(),
  rawResponse: jsonb("raw_response"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_inv_compliance_doc").on(
    table.orgId, table.kind, table.sourceType, table.sourceId, table.payloadHash,
  ),
  index("idx_inv_compliance_org_source").on(table.orgId, table.sourceType, table.sourceId),
  index("idx_inv_compliance_org_status").on(table.orgId, table.status, table.createdAt),
]);

/**
 * D2 — the minimum remaining shelf life a customer contracted for.
 *
 * Distinct from `invSettings.nearExpiryWindowDays`, and the distinction is the
 * whole point. The near-expiry window is an *operational preference*: one number
 * for the tenant, deciding whether the allocator reaches for short-dated stock
 * last or not at all. It changes the ORDER, or blocks pending an override.
 *
 * This is a *contract*. A supermarket's agreement says 120 days remaining on
 * arrival or the pallet comes back; the distributor next door accepts 30. FEFO
 * makes it worse rather than better, because FEFO hands every customer the lot
 * closest to its date — exactly the one the contract refuses. So the floor
 * removes lots from the candidate set, which no ordering rule can do, and it is
 * per customer, which no tenant-wide setting can be.
 *
 * `clientId === null` is the house floor: one row per organisation, applied to
 * every customer with no rule of their own. No row at all means no floor — a
 * shelf-life guarantee is a contract, and there is no default contract.
 *
 * Not a column on `clients`: that table belongs to CRM, and an allocation rule
 * hanging off it would put a warehouse concern in every CRM read (§1).
 */
export const invCustomerShelfLifeRules = pgTable("inv_customer_shelf_life_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /** Null is the organisation's house floor, not "every customer". */
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
  minShelfLifeDays: integer("min_shelf_life_days").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_cslr_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.clientId],
    foreignColumns: [clients.orgId, clients.id],
    name: "fk_inv_cslr_client_org",
  }),
  // Partial, both of them: Postgres treats NULLs as distinct, so a plain unique
  // on (org_id, client_id) would let a tenant accumulate five house rules that
  // silently disagree about the same question.
  uniqueIndex("uniq_inv_cslr_org_client")
    .on(table.orgId, table.clientId)
    .where(sql`client_id IS NOT NULL`),
  uniqueIndex("uniq_inv_cslr_org_house")
    .on(table.orgId)
    .where(sql`client_id IS NULL`),
]);

/**
 * D2 — every time somebody allocated stock the allocator had refused.
 *
 * The override already wrote an `inv_audit_events` row, and that row does not
 * answer "who shipped the short-dated stock, and why" six months later:
 * `InvAuditEventsService.list` deliberately does not project `after`, where the
 * reason lives (D7 drew that redaction line); the facts a reviewer needs — how
 * short-dated the lot was, what the policy said at the time, which customer got
 * it — are columns nowhere; and the question is a *report* across lots,
 * customers and months, which needs indexed columns rather than a JSONB blob.
 *
 * So the decision is a first-class row. The audit event stays: it is the
 * immutable event log, this is the domain record, and neither replaces the other.
 *
 * Append-only. Editing an override rewrites the reason a customer received stock
 * they may since have rejected, which is the evidence it exists to keep.
 */
export const invAllocationOverrides = pgTable("inv_allocation_overrides", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /** Not nullable. An override nobody is named on is a bypass with paperwork. */
  actorUserId: text("actor_user_id").references(() => users.id).notNull(),
  reason: text("reason").notNull(),
  /** What the allocator had said: `NEAR_EXPIRY` or `SHELF_LIFE`. */
  verdict: text("verdict").notNull(),
  productVariantId: integer("product_variant_id")
    .references(() => invProductVariants.id, { onDelete: "cascade" })
    .notNull(),
  /**
   * SET NULL, with the three snapshots beside it, so a purged lot cannot take
   * the evidence with it.
   */
  lotId: integer("lot_id").references(() => invLots.id, { onDelete: "set null" }),
  lotNumber: text("lot_number").notNull(),
  lotExpiryDate: date("lot_expiry_date").notNull(),
  daysRemaining: integer("days_remaining").notNull(),
  /**
   * The policy as it stood at the moment of the decision. Settings are mutable;
   * without these the row cannot say which rule was actually overridden.
   */
  nearExpiryPolicy: text("near_expiry_policy").notNull(),
  nearExpiryWindowDays: integer("near_expiry_window_days").notNull(),
  minShelfLifeDays: integer("min_shelf_life_days").notNull(),
  /** Where the stock went: the document, and the customer behind it. */
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  reservationId: integer("reservation_id").references(() => invStockReservations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_inv_allocation_overrides_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_alloc_ovr_variant_org",
  }),
  foreignKey({
    columns: [table.orgId, table.lotId],
    foreignColumns: [invLots.orgId, invLots.id],
    name: "fk_inv_alloc_ovr_lot_org",
  }),
  foreignKey({
    columns: [table.orgId, table.clientId],
    foreignColumns: [clients.orgId, clients.id],
    name: "fk_inv_alloc_ovr_client_org",
  }),
  foreignKey({
    columns: [table.orgId, table.reservationId],
    foreignColumns: [invStockReservations.orgId, invStockReservations.id],
    name: "fk_inv_alloc_ovr_reservation_org",
  }),
  // Keyset on (created_at, id): one allocation can write several rows in one
  // transaction, so `created_at` alone repeats and a cursor on it would skip or
  // duplicate at a page boundary.
  index("idx_inv_alloc_ovr_org_created_id").on(table.orgId, desc(table.createdAt), desc(table.id)),
  // "Where did this lot go, and on whose authority" — the recall question.
  index("idx_inv_alloc_ovr_org_lot")
    .on(table.orgId, table.lotId, desc(table.createdAt))
    .where(sql`lot_id IS NOT NULL`),
  // "What short-dated stock has this customer been sent" — the complaint question.
  index("idx_inv_alloc_ovr_org_client")
    .on(table.orgId, table.clientId, desc(table.createdAt))
    .where(sql`client_id IS NOT NULL`),
]);

export const invCustomerShelfLifeRulesRelations = relations(invCustomerShelfLifeRules, ({ one }) => ({
  organization: one(organizations, { fields: [invCustomerShelfLifeRules.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [invCustomerShelfLifeRules.clientId], references: [clients.id] }),
}));

export const invAllocationOverridesRelations = relations(invAllocationOverrides, ({ one }) => ({
  organization: one(organizations, { fields: [invAllocationOverrides.orgId], references: [organizations.id] }),
  lot: one(invLots, { fields: [invAllocationOverrides.lotId], references: [invLots.id] }),
  client: one(clients, { fields: [invAllocationOverrides.clientId], references: [clients.id] }),
  productVariant: one(invProductVariants, {
    fields: [invAllocationOverrides.productVariantId],
    references: [invProductVariants.id],
  }),
}));
