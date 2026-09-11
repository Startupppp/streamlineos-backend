/**
 * What the organisation has to be able to show afterwards.
 *
 * The immutable audit event log and the reproducible exports taken from it, the
 * statutory documents an adapter filed and what it said back, the shelf-life
 * floors customers contracted for, and every allocation a named operator made
 * that the allocator had refused. They are one file because they answer one
 * question — what happened, and on whose authority — and because each is
 * append-only for that reason: editing any of them rewrites the evidence it
 * exists to keep.
 */

import { pgTable, text, serial, timestamp, decimal, integer, bigint, date, boolean, jsonb, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { desc, relations, sql } from "drizzle-orm";
import { invJobStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invLots } from "./traceability";
import { invStockReservations } from "./reservations";

export const invAuditEvents = pgTable("inv_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actorUserId: text("actor_user_id").references(() => users.id),
  actorMembershipId: integer("actor_membership_id"),
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
  /**
   * Null is the organisation's house floor, not "every customer". A plain
   * integer since the legacy `clients` table left the Drizzle schema; the
   * foreign key and relation went with it, as on `inv_customer_returns`.
   */
  clientId: integer("client_id"),
  minShelfLifeDays: integer("min_shelf_life_days").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_cslr_org_id").on(table.orgId, table.id),
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
  /** A plain integer since the legacy `clients` table left the Drizzle schema. */
  clientId: integer("client_id"),
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
}));

export const invAllocationOverridesRelations = relations(invAllocationOverrides, ({ one }) => ({
  organization: one(organizations, { fields: [invAllocationOverrides.orgId], references: [organizations.id] }),
  lot: one(invLots, { fields: [invAllocationOverrides.lotId], references: [invLots.id] }),
  productVariant: one(invProductVariants, {
    fields: [invAllocationOverrides.productVariantId],
    references: [invProductVariants.id],
  }),
}));
