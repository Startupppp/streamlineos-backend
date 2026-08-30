-- 0524 — c26: Invoice snapshot tables
--
-- Five tables for the immutable invoice ledger. Dependency order within this file:
--
--   billing_invoice_number_sequences  — per-org serial counter (org_id, prefix, year)
--   billing_invoice_snapshots         — invoice header (tax, FX, totals snapshotted)
--     └── billing_invoice_line_snapshots — normalized line items
--   billing_credit_notes              — credit/debit notes referencing a frozen invoice
--     └── billing_credit_note_lines   — normalized credit note lines
--
-- Cross-file dependencies: billing_proration_lines (0522), billing_usage_rollups (0523).
-- This migration must run after both 0522 and 0523.
--
-- All five tables are tenant-scoped and require RLS.
--
-- Note on immutability: the schema relies on trigger trg_invoice_immutability
-- (migration 0492) to prevent mutation of ISSUED invoices. That trigger is journalled
-- separately and is a prerequisite for criterion 1 of ticket 05. This migration
-- creates the tables; 0492 must also be confirmed applied.
--
-- Note on idx_billing_inv_lines_snapshot and idx_billing_credit_note_lines_note:
-- these index only snapshot_id / credit_note_id without an org_id prefix. They exist
-- for parent → child FK navigation where the parent row is already RLS-filtered; the
-- planner uses the parent's org_id from the outer scan. Tenant-scoped list queries use
-- idx_billing_inv_lines_org and idx_billing_credit_note_lines_org instead.
--
-- Operator notes — indexes
-- ────────────────────────
-- Run CONCURRENTLY forms by hand before applying on a live table:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_inv_num_seq_org_prefix_year"
--     ON "billing_invoice_number_sequences" ("org_id", "prefix", "year");
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_inv_snap_org_number"
--     ON "billing_invoice_snapshots" ("org_id", "invoice_number");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_inv_snap_org_status"
--     ON "billing_invoice_snapshots" ("org_id", "status");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_inv_snap_org_sub"
--     ON "billing_invoice_snapshots" ("org_id", "subscription_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_inv_snap_org_issued"
--     ON "billing_invoice_snapshots" ("org_id", "issued_at" DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_inv_lines_snapshot"
--     ON "billing_invoice_line_snapshots" ("snapshot_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_inv_lines_org"
--     ON "billing_invoice_line_snapshots" ("org_id", "snapshot_id");
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_credit_notes_org_number"
--     ON "billing_credit_notes" ("org_id", "note_number");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_credit_notes_org_snap"
--     ON "billing_credit_notes" ("org_id", "original_snapshot_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_credit_notes_org_status"
--     ON "billing_credit_notes" ("org_id", "status");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_credit_note_lines_note"
--     ON "billing_credit_note_lines" ("credit_note_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_credit_note_lines_org"
--     ON "billing_credit_note_lines" ("org_id", "credit_note_id");

SET lock_timeout = '5s';

-- ─── billing_invoice_number_sequences ────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_invoice_number_sequences" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"      text NOT NULL,
  "prefix"      varchar(20) NOT NULL DEFAULT 'INV',
  "year"        integer NOT NULL,
  "last_number" integer NOT NULL DEFAULT 0,
  "updated_at"  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_invoice_number_sequences_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_invoice_number_sequences"
  ADD CONSTRAINT "billing_invoice_number_sequences_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_number_sequences"
  VALIDATE CONSTRAINT "billing_invoice_number_sequences_org_id_organizations_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_inv_num_seq_org_prefix_year"
  ON "billing_invoice_number_sequences" ("org_id", "prefix", "year");

--> statement-breakpoint
ALTER TABLE "billing_invoice_number_sequences" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_invoice_number_sequences";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_invoice_number_sequences"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_invoice_number_sequences" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_invoice_number_sequences" TO streamline_app;

-- ─── billing_invoice_snapshots ───────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_invoice_snapshots" (
  "id"                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"             text NOT NULL,
  "subscription_id"    integer,
  "invoice_number"     varchar(50) NOT NULL,
  "status"             varchar(20) NOT NULL DEFAULT 'DRAFT',
  "seller_name"        varchar(255),
  "seller_address"     jsonb,
  "seller_tax_ids"     jsonb,
  "buyer_name"         varchar(255),
  "buyer_address"      jsonb,
  "buyer_tax_ids"      jsonb,
  "place_of_supply"    varchar(100),
  "tax_behavior"       varchar(20) NOT NULL,
  "currency"           varchar(3) NOT NULL,
  "fx_rate_micro"      bigint,
  "fx_rate_source"     varchar(100),
  "fx_rate_captured_at" timestamp,
  "subtotal_minor"     integer NOT NULL,
  "tax_amount_minor"   integer NOT NULL,
  "total_minor"        integer NOT NULL,
  "rounding_rule"      varchar(10) NOT NULL DEFAULT 'HALF_UP',
  "period_start"       timestamp,
  "period_end"         timestamp,
  "issued_at"          timestamp,
  "due_at"             timestamp,
  "paid_at"            timestamp,
  "voided_at"          timestamp,
  "created_by"         text,
  "created_at"         timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_invoice_snapshots_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  ADD CONSTRAINT "billing_invoice_snapshots_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_snapshots_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  ADD CONSTRAINT "billing_invoice_snapshots_subscription_id_subscriptions_id_fk"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_snapshots_subscription_id_subscriptions_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  ADD CONSTRAINT "billing_invoice_snapshots_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_snapshots_created_by_users_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_inv_snap_org_number"
  ON "billing_invoice_snapshots" ("org_id", "invoice_number");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_inv_snap_org_status"
  ON "billing_invoice_snapshots" ("org_id", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_inv_snap_org_sub"
  ON "billing_invoice_snapshots" ("org_id", "subscription_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_inv_snap_org_issued"
  ON "billing_invoice_snapshots" ("org_id", "issued_at" DESC);

--> statement-breakpoint
ALTER TABLE "billing_invoice_snapshots" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_invoice_snapshots";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_invoice_snapshots"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_invoice_snapshots" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_invoice_snapshots" TO streamline_app;

-- ─── billing_invoice_line_snapshots ──────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_invoice_line_snapshots" (
  "id"                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "snapshot_id"       bigint NOT NULL,
  "org_id"            text NOT NULL,
  "line_type"         varchar(20) NOT NULL,
  "description"       text NOT NULL,
  "quantity"          integer NOT NULL,
  "unit_amount_minor" integer NOT NULL,
  "currency"          varchar(3) NOT NULL,
  "subtotal_minor"    integer NOT NULL,
  "tax_rate_bps"      integer NOT NULL DEFAULT 0,
  "tax_amount_minor"  integer NOT NULL,
  "total_minor"       integer NOT NULL,
  "proration_line_id" bigint,
  "usage_rollup_id"   bigint,
  "sort_order"        integer NOT NULL DEFAULT 0,
  "created_at"        timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_invoice_line_snapshots_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  ADD CONSTRAINT "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snapshots_id_fk"
  FOREIGN KEY ("snapshot_id") REFERENCES "billing_invoice_snapshots"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snapshots_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  ADD CONSTRAINT "billing_invoice_line_snapshots_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_line_snapshots_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  ADD CONSTRAINT "billing_invoice_line_snapshots_proration_line_id_billing_proration_lines_id_fk"
  FOREIGN KEY ("proration_line_id") REFERENCES "billing_proration_lines"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_line_snapshots_proration_line_id_billing_proration_lines_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  ADD CONSTRAINT "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_rollups_id_fk"
  FOREIGN KEY ("usage_rollup_id") REFERENCES "billing_usage_rollups"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots"
  VALIDATE CONSTRAINT "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_rollups_id_fk";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_inv_lines_snapshot"
  ON "billing_invoice_line_snapshots" ("snapshot_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_inv_lines_org"
  ON "billing_invoice_line_snapshots" ("org_id", "snapshot_id");

--> statement-breakpoint
ALTER TABLE "billing_invoice_line_snapshots" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_invoice_line_snapshots";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_invoice_line_snapshots"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_invoice_line_snapshots" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_invoice_line_snapshots" TO streamline_app;

-- ─── billing_credit_notes ────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_credit_notes" (
  "id"                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"               text NOT NULL,
  "original_snapshot_id" bigint NOT NULL,
  "note_number"          varchar(50) NOT NULL,
  "note_type"            varchar(10) NOT NULL,
  "reason"               text NOT NULL,
  "currency"             varchar(3) NOT NULL,
  "total_minor"          integer NOT NULL,
  "status"               varchar(20) NOT NULL DEFAULT 'DRAFT',
  "issued_at"            timestamp,
  "voided_at"            timestamp,
  "created_by"           text NOT NULL,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_credit_notes_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  ADD CONSTRAINT "billing_credit_notes_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  VALIDATE CONSTRAINT "billing_credit_notes_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  ADD CONSTRAINT "billing_credit_notes_original_snapshot_id_billing_invoice_snapshots_id_fk"
  FOREIGN KEY ("original_snapshot_id") REFERENCES "billing_invoice_snapshots"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  VALIDATE CONSTRAINT "billing_credit_notes_original_snapshot_id_billing_invoice_snapshots_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  ADD CONSTRAINT "billing_credit_notes_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_credit_notes"
  VALIDATE CONSTRAINT "billing_credit_notes_created_by_users_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_credit_notes_org_number"
  ON "billing_credit_notes" ("org_id", "note_number");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_credit_notes_org_snap"
  ON "billing_credit_notes" ("org_id", "original_snapshot_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_credit_notes_org_status"
  ON "billing_credit_notes" ("org_id", "status");

--> statement-breakpoint
ALTER TABLE "billing_credit_notes" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_credit_notes";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_credit_notes"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_credit_notes" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_credit_notes" TO streamline_app;

-- ─── billing_credit_note_lines ───────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_credit_note_lines" (
  "id"                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "credit_note_id"    bigint NOT NULL,
  "org_id"            text NOT NULL,
  "description"       text NOT NULL,
  "quantity"          integer NOT NULL,
  "unit_amount_minor" integer NOT NULL,
  "currency"          varchar(3) NOT NULL,
  "subtotal_minor"    integer NOT NULL,
  "tax_rate_bps"      integer NOT NULL DEFAULT 0,
  "tax_amount_minor"  integer NOT NULL,
  "total_minor"       integer NOT NULL,
  "sort_order"        integer NOT NULL DEFAULT 0,
  "created_at"        timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_credit_note_lines_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_credit_note_lines"
  ADD CONSTRAINT "billing_credit_note_lines_credit_note_id_billing_credit_notes_id_fk"
  FOREIGN KEY ("credit_note_id") REFERENCES "billing_credit_notes"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_credit_note_lines"
  VALIDATE CONSTRAINT "billing_credit_note_lines_credit_note_id_billing_credit_notes_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_credit_note_lines"
  ADD CONSTRAINT "billing_credit_note_lines_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_credit_note_lines"
  VALIDATE CONSTRAINT "billing_credit_note_lines_org_id_organizations_id_fk";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_credit_note_lines_note"
  ON "billing_credit_note_lines" ("credit_note_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_credit_note_lines_org"
  ON "billing_credit_note_lines" ("org_id", "credit_note_id");

--> statement-breakpoint
ALTER TABLE "billing_credit_note_lines" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_credit_note_lines";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_credit_note_lines"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_credit_note_lines" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_credit_note_lines" TO streamline_app;
