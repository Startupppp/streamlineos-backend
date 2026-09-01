-- inv_carton_types and inv_shipment_status_events missing from the chain at the
-- point 0650 runs.
--
-- Root cause: these two tables were created on the live database via `drizzle-kit push`
-- and never had a corresponding CREATE TABLE migration. The first migration to CREATE
-- these tables is 0655_chain_creates_remaining_catalog_objects (journal idx=370), but
-- 0655 is placed AFTER 0650_tenant_isolation_for_three_unprotected_tables (idx=366) in
-- the journal. On a cold replay, when 0650 runs and attempts
-- `ALTER TABLE "inv_carton_types" ENABLE ROW LEVEL SECURITY`, the table does not yet
-- exist and the statement fails with 42P01.
--
-- This file is the structural fix. It is placed between 0649 (idx=365) and 0650
-- (idx=366) in the journal so a cold bootstrap creates these tables before 0650 runs.
-- Every statement is idempotent (CREATE SEQUENCE IF NOT EXISTS, CREATE TABLE IF NOT
-- EXISTS), so this file is a complete no-op against any database that already holds
-- these objects — including the live production database.
--
-- Constraints, indexes, RLS policies and GRANT statements for these tables remain in
-- 0650 (RLS enable + policy + grants) and 0655 (constraints, indexes, additional
-- cleanup). The CREATE TABLE statements carry no inline REFERENCES clauses, so there is
-- no ordering dependency among the tables within this file.
--
-- The sequences must be created before the tables because the tables reference them in
-- DEFAULT expressions. The inv_shipment_status enum type is already created in 0000.
--
-- WATERMARK INTERACTION (read this before changing the `when` value):
--   apply-chain-cold.mjs processes journal entries in JSON ARRAY ORDER, not by `when`.
--   This file is positioned between idx=365 (0649) and idx=366 (0650) in the array, so
--   a cold bootstrap runs it before 0650 regardless of `when`. Drizzle-kit on PRODUCTION
--   uses `when` to determine what to apply: it skips any journal entry whose
--   `when` <= max applied `when`. This file's `when` (1798000157000) is above the
--   production watermark at the time it was authored, so production will apply it as a
--   normal pending migration. All statements are idempotent (IF NOT EXISTS), so the
--   apply is a no-op and is safe.
--
--   Do NOT lower `when` below the production watermark: a journal entry below the
--   watermark that is not in the applied set is flagged as SKIPPED by
--   check-migration-ledger.mjs and will never apply.
--
-- Mirrors 0591b_gl_ap_ar_bank_tax_chain_repair and 0767b_inv_table_chain_repair exactly
-- in pattern and rationale; those migrations fixed the same class of push-created tables
-- for the gl/ap/ar/bank/tax and inv_* families respectively.

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_carton_types_id_seq" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;

--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_shipment_status_events_id_seq" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_carton_types" (
  "id" integer DEFAULT nextval('inv_carton_types_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "inner_length_mm" integer NOT NULL,
  "inner_width_mm" integer NOT NULL,
  "inner_height_mm" integer NOT NULL,
  "max_weight_grams" integer NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_shipment_status_events" (
  "id" integer DEFAULT nextval('inv_shipment_status_events_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "shipment_id" integer NOT NULL,
  "carrier_id" integer,
  "status" inv_shipment_status NOT NULL,
  "occurred_at" timestamp without time zone NOT NULL,
  "received_at" timestamp without time zone DEFAULT now() NOT NULL,
  "carrier_event_id" text,
  "description" text,
  "raw_payload" jsonb,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
