import { relations } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { subscriptions } from "../common/subscriptions";
import { billingProrationLines } from "./proration-ledger";
import { billingUsageRollups } from "./usage-events";

export const billingInvoiceNumberSequences = pgTable(
  "billing_invoice_number_sequences",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    prefix: varchar("prefix", { length: 20 }).notNull().default("INV"),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_inv_num_seq_org_prefix_year").on(t.orgId, t.prefix, t.year),
    unique("uniq_billing_invoice_number_sequences_org_id").on(t.orgId, t.id),
  ],
);

export const billingInvoiceSnapshots = pgTable(
  "billing_invoice_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: integer("subscription_id"),
    invoiceNumber: varchar("invoice_number", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"),
    sellerName: varchar("seller_name", { length: 255 }),
    sellerAddress: jsonb("seller_address").$type<Record<string, unknown>>(),
    sellerTaxIds: jsonb("seller_tax_ids").$type<Record<string, string>>(),
    buyerName: varchar("buyer_name", { length: 255 }),
    buyerAddress: jsonb("buyer_address").$type<Record<string, unknown>>(),
    buyerTaxIds: jsonb("buyer_tax_ids").$type<Record<string, string>>(),
    placeOfSupply: varchar("place_of_supply", { length: 100 }),
    taxBehavior: varchar("tax_behavior", { length: 20 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    fxRateMicro: bigint("fx_rate_micro", { mode: "number" }),
    fxRateSource: varchar("fx_rate_source", { length: 100 }),
    fxRateCapturedAt: timestamp("fx_rate_captured_at"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxAmountMinor: integer("tax_amount_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    roundingRule: varchar("rounding_rule", { length: 10 }).notNull().default("HALF_UP"),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    issuedAt: timestamp("issued_at"),
    dueAt: timestamp("due_at"),
    paidAt: timestamp("paid_at"),
    voidedAt: timestamp("voided_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_inv_snap_org_number").on(t.orgId, t.invoiceNumber),
    index("idx_billing_inv_snap_org_status").on(t.orgId, t.status),
    index("idx_billing_inv_snap_org_sub").on(t.orgId, t.subscriptionId),
    index("idx_billing_inv_snap_org_issued").on(t.orgId, t.issuedAt.desc()),
    unique("uniq_billing_invoice_snapshots_org_id").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.subscriptionId], foreignColumns: [subscriptions.orgId, subscriptions.id], name: "fk_billing_inv_snap_org_sub" }),
  ],
);

export const billingInvoiceLineSnapshots = pgTable(
  "billing_invoice_line_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    snapshotId: bigint("snapshot_id", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    lineType: varchar("line_type", { length: 20 }).notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    taxAmountMinor: integer("tax_amount_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    prorationLineId: bigint("proration_line_id", { mode: "number" }),
    usageRollupId: bigint("usage_rollup_id", { mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.prorationLineId], foreignColumns: [billingProrationLines.orgId, billingProrationLines.id], name: "fk_billing_invoice_line_snapshots_proration_line_id_org" }).onDelete("set null"),
  foreignKey({ columns: [t.orgId, t.snapshotId], foreignColumns: [billingInvoiceSnapshots.orgId, billingInvoiceSnapshots.id], name: "fk_billing_invoice_line_snapshots_snapshot_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.usageRollupId], foreignColumns: [billingUsageRollups.orgId, billingUsageRollups.id], name: "fk_billing_invoice_line_snapshots_usage_rollup_id_org" }).onDelete("set null"),
    index("idx_billing_inv_lines_snapshot").on(t.snapshotId),
    index("idx_billing_inv_lines_org").on(t.orgId, t.snapshotId),
    unique("uniq_billing_invoice_line_snapshots_org_id").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.snapshotId], foreignColumns: [billingInvoiceSnapshots.orgId, billingInvoiceSnapshots.id], name: "fk_billing_inv_lines_org_snap" }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.prorationLineId], foreignColumns: [billingProrationLines.orgId, billingProrationLines.id], name: "fk_billing_inv_lines_org_proration" }),
    foreignKey({ columns: [t.orgId, t.usageRollupId], foreignColumns: [billingUsageRollups.orgId, billingUsageRollups.id], name: "fk_billing_inv_lines_org_rollup" }),
  ],
);

export const billingCreditNotes = pgTable(
  "billing_credit_notes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    originalSnapshotId: bigint("original_snapshot_id", { mode: "number" }).notNull(),
    noteNumber: varchar("note_number", { length: 50 }).notNull(),
    noteType: varchar("note_type", { length: 10 }).notNull(),
    reason: text("reason").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    totalMinor: integer("total_minor").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"),
    issuedAt: timestamp("issued_at"),
    voidedAt: timestamp("voided_at"),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.originalSnapshotId], foreignColumns: [billingInvoiceSnapshots.orgId, billingInvoiceSnapshots.id], name: "fk_billing_credit_notes_original_snapshot_id_org" }).onDelete("restrict"),
    uniqueIndex("uq_billing_credit_notes_org_number").on(t.orgId, t.noteNumber),
    index("idx_billing_credit_notes_org_snap").on(t.orgId, t.originalSnapshotId),
    index("idx_billing_credit_notes_org_status").on(t.orgId, t.status),
    unique("uniq_billing_credit_notes_org_id").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.originalSnapshotId], foreignColumns: [billingInvoiceSnapshots.orgId, billingInvoiceSnapshots.id], name: "fk_billing_credit_notes_org_snap" }).onDelete("restrict"),
  ],
);

export const billingCreditNoteLines = pgTable(
  "billing_credit_note_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    creditNoteId: bigint("credit_note_id", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    taxAmountMinor: integer("tax_amount_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.creditNoteId], foreignColumns: [billingCreditNotes.orgId, billingCreditNotes.id], name: "fk_billing_credit_note_lines_credit_note_id_org" }).onDelete("cascade"),
    index("idx_billing_credit_note_lines_note").on(t.creditNoteId),
    index("idx_billing_credit_note_lines_org").on(t.orgId, t.creditNoteId),
    unique("uniq_billing_credit_note_lines_org_id").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.creditNoteId], foreignColumns: [billingCreditNotes.orgId, billingCreditNotes.id], name: "fk_billing_credit_note_lines_org_note" }).onDelete("cascade"),
  ],
);

export const billingInvoiceNumberSequencesRelations = relations(billingInvoiceNumberSequences, ({ one }) => ({
  organization: one(organizations, { fields: [billingInvoiceNumberSequences.orgId], references: [organizations.id] }),
}));

export const billingInvoiceSnapshotsRelations = relations(billingInvoiceSnapshots, ({ one, many }) => ({
  organization: one(organizations, { fields: [billingInvoiceSnapshots.orgId], references: [organizations.id] }),
  subscription: one(subscriptions, { fields: [billingInvoiceSnapshots.subscriptionId], references: [subscriptions.id] }),
  createdByUser: one(users, { fields: [billingInvoiceSnapshots.createdBy], references: [users.id] }),
  lines: many(billingInvoiceLineSnapshots),
  creditNotes: many(billingCreditNotes),
}));

export const billingInvoiceLineSnapshotsRelations = relations(billingInvoiceLineSnapshots, ({ one }) => ({
  snapshot: one(billingInvoiceSnapshots, { fields: [billingInvoiceLineSnapshots.snapshotId], references: [billingInvoiceSnapshots.id] }),
  organization: one(organizations, { fields: [billingInvoiceLineSnapshots.orgId], references: [organizations.id] }),
  prorationLine: one(billingProrationLines, { fields: [billingInvoiceLineSnapshots.prorationLineId], references: [billingProrationLines.id] }),
  usageRollup: one(billingUsageRollups, { fields: [billingInvoiceLineSnapshots.usageRollupId], references: [billingUsageRollups.id] }),
}));

export const billingCreditNotesRelations = relations(billingCreditNotes, ({ one, many }) => ({
  organization: one(organizations, { fields: [billingCreditNotes.orgId], references: [organizations.id] }),
  originalSnapshot: one(billingInvoiceSnapshots, { fields: [billingCreditNotes.originalSnapshotId], references: [billingInvoiceSnapshots.id] }),
  createdByUser: one(users, { fields: [billingCreditNotes.createdBy], references: [users.id] }),
  lines: many(billingCreditNoteLines),
}));

export const billingCreditNoteLinesRelations = relations(billingCreditNoteLines, ({ one }) => ({
  creditNote: one(billingCreditNotes, { fields: [billingCreditNoteLines.creditNoteId], references: [billingCreditNotes.id] }),
  organization: one(organizations, { fields: [billingCreditNoteLines.orgId], references: [organizations.id] }),
}));
