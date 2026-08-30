-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.

-- Same as 0619: the policies below call `current_org_id()` unqualified, and this
-- journal only creates `app.current_org_id` (0374). Setting the path for this
-- file resolves them to that function; PostgreSQL stores the resolved,
-- schema-qualified reference, so the result is identical to writing `app.` at
-- every call. Each migration gets its own connection, so this reaches no other.
SET search_path = public, app;
--> statement-breakpoint
-- The objects the running control plane has that the committed chain still never creates,
-- generated from pg_catalog by cell:chain-repair --direction=forward.
--
-- Placed before 0650_tenant_isolation_for_three_unprotected_tables, which is where the
-- remaining chain gaps are: it protects inv_carton_types and inv_shipment_status_events,
-- and neither table was ever in the chain.
--
-- EXCLUDED DELIBERATELY: every statement naming event_attendees. The generator runs forward
-- (control plane -> chain), and the control plane still carries event_attendees_event_user_unique
-- and its foreign keys to users(id) only because S3s calendar actor migration has landed in the
-- chain and not yet in the control plane. The chain is AHEAD there, so copying those back would
-- re-add the legacy user-keyed constraints ticket 13 exists to remove. A forward repair is not
-- automatically correct; it is correct only where production is ahead, not where the chain is.

SET statement_timeout = 0;
SET lock_timeout = '5s';
--> statement-breakpoint
-- Objects the running control plane has that the committed migration chain never creates.
--
-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=forward.
-- A cold build of a cell reaches head and is still short of these, so the chain cannot
-- reproduce the database it is supposed to describe. Every statement is idempotent, so
-- this file is a no-op against the control plane that supplied it.

--
-- sequences (6)
--
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_carton_types_id_seq" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_shipment_status_events_id_seq" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."leads_id_seq1" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."clients_id_seq1" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."contacts_id_seq1" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."crm_organizations_id_seq1" AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
--
-- enum types the chain never creates (2)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'inv_grn_discrepancy') THEN
    CREATE TYPE "public"."inv_grn_discrepancy" AS ENUM ('SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'inv_pick_exception') THEN
    CREATE TYPE "public"."inv_pick_exception" AS ENUM ('SHORT', 'NOT_FOUND', 'DAMAGED', 'SUBSTITUTED');
  END IF;
END $repair$;
--> statement-breakpoint
--
-- tables (2)
--
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
--> statement-breakpoint
--
-- columns on tables that already exist (18)
--
--> statement-breakpoint
DO $g16$
BEGIN
  IF to_regclass('public."inv_customer_return_lines"') IS NOT NULL THEN
    EXECUTE $s16$
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspected_at" timestamp without time zone
$s16$;
  END IF;
END $g16$;
--> statement-breakpoint
DO $g17$
BEGIN
  IF to_regclass('public."inv_customer_return_lines"') IS NOT NULL THEN
    EXECUTE $s17$
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspected_by" text
$s17$;
  END IF;
END $g17$;
--> statement-breakpoint
DO $g18$
BEGIN
  IF to_regclass('public."inv_customer_return_lines"') IS NOT NULL THEN
    EXECUTE $s18$
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspection_notes" text
$s18$;
  END IF;
END $g18$;
--> statement-breakpoint
DO $g19$
BEGIN
  IF to_regclass('public."inv_grn_lines"') IS NOT NULL THEN
    EXECUTE $s19$
ALTER TABLE "public"."inv_grn_lines" ADD COLUMN IF NOT EXISTS "quantity_expected" numeric(18,4)
$s19$;
  END IF;
END $g19$;
--> statement-breakpoint
DO $g20$
BEGIN
  IF to_regclass('public."inv_grn_lines"') IS NOT NULL THEN
    EXECUTE $s20$
ALTER TABLE "public"."inv_grn_lines" ADD COLUMN IF NOT EXISTS "discrepancy_reason" inv_grn_discrepancy
$s20$;
  END IF;
END $g20$;
--> statement-breakpoint
DO $g21$
BEGIN
  IF to_regclass('public."inv_packages"') IS NOT NULL THEN
    EXECUTE $s21$
ALTER TABLE "public"."inv_packages" ADD COLUMN IF NOT EXISTS "carton_type_id" integer
$s21$;
  END IF;
END $g21$;
--> statement-breakpoint
DO $g22$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s22$
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "exception_reason" inv_pick_exception
$s22$;
  END IF;
END $g22$;
--> statement-breakpoint
DO $g23$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s23$
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "exception_notes" text
$s23$;
  END IF;
END $g23$;
--> statement-breakpoint
DO $g24$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s24$
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "substitute_variant_id" integer
$s24$;
  END IF;
END $g24$;
--> statement-breakpoint
DO $g25$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s25$
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "substitute_quantity" numeric(18,4)
$s25$;
  END IF;
END $g25$;
--> statement-breakpoint
DO $g26$
BEGIN
  IF to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s26$
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "weight_grams" integer
$s26$;
  END IF;
END $g26$;
--> statement-breakpoint
DO $g27$
BEGIN
  IF to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s27$
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "length_mm" integer
$s27$;
  END IF;
END $g27$;
--> statement-breakpoint
DO $g28$
BEGIN
  IF to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s28$
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "width_mm" integer
$s28$;
  END IF;
END $g28$;
--> statement-breakpoint
DO $g29$
BEGIN
  IF to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s29$
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "height_mm" integer
$s29$;
  END IF;
END $g29$;
--> statement-breakpoint
DO $g30$
BEGIN
  IF to_regclass('public."inv_products"') IS NOT NULL THEN
    EXECUTE $s30$
ALTER TABLE "public"."inv_products" ADD COLUMN IF NOT EXISTS "min_order_qty" numeric(18,4)
$s30$;
  END IF;
END $g30$;
--> statement-breakpoint
DO $g31$
BEGIN
  IF to_regclass('public."inv_products"') IS NOT NULL THEN
    EXECUTE $s31$
ALTER TABLE "public"."inv_products" ADD COLUMN IF NOT EXISTS "order_multiple" numeric(18,4)
$s31$;
  END IF;
END $g31$;
--> statement-breakpoint
DO $g32$
BEGIN
  IF to_regclass('public."inv_settings"') IS NOT NULL THEN
    EXECUTE $s32$
ALTER TABLE "public"."inv_settings" ADD COLUMN IF NOT EXISTS "po_approval_threshold" numeric(18,4)
$s32$;
  END IF;
END $g32$;
--> statement-breakpoint
DO $g33$
BEGIN
  IF to_regclass('public."inv_stock_transactions"') IS NOT NULL THEN
    EXECUTE $s33$
ALTER TABLE "public"."inv_stock_transactions" ADD COLUMN IF NOT EXISTS "correction_of_transaction_id" integer
$s33$;
  END IF;
END $g33$;
--> statement-breakpoint
--
-- functions (1)
--
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inv_stock_transactions_no_restatement()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN NEW.org_id                       IS DISTINCT FROM OLD.org_id                       THEN 'org_id'
    WHEN NEW.product_variant_id           IS DISTINCT FROM OLD.product_variant_id           THEN 'product_variant_id'
    WHEN NEW.location_id                  IS DISTINCT FROM OLD.location_id                  THEN 'location_id'
    WHEN NEW.transaction_type             IS DISTINCT FROM OLD.transaction_type             THEN 'transaction_type'
    WHEN NEW.quantity_bucket              IS DISTINCT FROM OLD.quantity_bucket              THEN 'quantity_bucket'
    -- numeric comparison, so '5.0000' and '5.00' are the same quantity
    WHEN NEW.quantity_change              IS DISTINCT FROM OLD.quantity_change              THEN 'quantity_change'
    WHEN NEW.quantity_before              IS DISTINCT FROM OLD.quantity_before              THEN 'quantity_before'
    WHEN NEW.quantity_after               IS DISTINCT FROM OLD.quantity_after               THEN 'quantity_after'
    WHEN NEW.lot_id                       IS DISTINCT FROM OLD.lot_id                       THEN 'lot_id'
    WHEN NEW.serial_id                    IS DISTINCT FROM OLD.serial_id                    THEN 'serial_id'
    WHEN NEW.unit_cost                    IS DISTINCT FROM OLD.unit_cost                    THEN 'unit_cost'
    WHEN NEW.total_cost                   IS DISTINCT FROM OLD.total_cost                   THEN 'total_cost'
    WHEN NEW.posting_date                 IS DISTINCT FROM OLD.posting_date                 THEN 'posting_date'
    WHEN NEW.idempotency_key              IS DISTINCT FROM OLD.idempotency_key              THEN 'idempotency_key'
    WHEN NEW.reference_type               IS DISTINCT FROM OLD.reference_type               THEN 'reference_type'
    WHEN NEW.reference_id                 IS DISTINCT FROM OLD.reference_id                 THEN 'reference_id'
    WHEN NEW.correction_of_transaction_id IS DISTINCT FROM OLD.correction_of_transaction_id THEN 'correction_of_transaction_id'
    WHEN NEW.created_by                   IS DISTINCT FROM OLD.created_by                   THEN 'created_by'
    WHEN NEW.created_at                   IS DISTINCT FROM OLD.created_at                   THEN 'created_at'
    ELSE NULL
  END;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION
      'inv_stock_transactions is append-only: % cannot be changed on posted movement %',
      changed, OLD.id
      USING ERRCODE = '23514',
            HINT = 'Post a compensating movement with correction_of_transaction_id instead of editing this one.';
  END IF;

  RETURN NEW;
END $function$
;
--> statement-breakpoint
--
-- primary keys, unique and check constraints (8)
--
--> statement-breakpoint
DO $g37$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s37$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_pkey') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_pkey" PRIMARY KEY (id);
  END IF;
END $repair$
$s37$;
  END IF;
END $g37$;
--> statement-breakpoint
DO $g38$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s38$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'uniq_inv_carton_types_org_code') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "uniq_inv_carton_types_org_code" UNIQUE (org_id, code);
  END IF;
END $repair$
$s38$;
  END IF;
END $g38$;
--> statement-breakpoint
DO $g39$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s39$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'uniq_inv_carton_types_org_id') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "uniq_inv_carton_types_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s39$;
  END IF;
END $g39$;
--> statement-breakpoint
DO $g40$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s40$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'chk_inv_carton_types_positive') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "chk_inv_carton_types_positive" CHECK (((inner_length_mm > 0) AND (inner_width_mm > 0) AND (inner_height_mm > 0) AND (max_weight_grams > 0)));
  END IF;
END $repair$
$s40$;
  END IF;
END $g40$;
--> statement-breakpoint
DO $g41$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s41$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_pkey') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_pkey" PRIMARY KEY (id);
  END IF;
END $repair$
$s41$;
  END IF;
END $g41$;
--> statement-breakpoint
DO $g42$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s42$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_pick_list_lines' AND k.conname = 'chk_inv_pick_lines_substitute_pair') THEN
    ALTER TABLE "public"."inv_pick_list_lines" ADD CONSTRAINT "chk_inv_pick_lines_substitute_pair" CHECK ((((substitute_variant_id IS NULL) AND (substitute_quantity IS NULL)) OR ((substitute_variant_id IS NOT NULL) AND (substitute_quantity IS NOT NULL)))) NOT VALID;
  END IF;
END $repair$
$s42$;
  END IF;
END $g42$;
--> statement-breakpoint
DO $g43$
BEGIN
  IF to_regclass('public."inv_products"') IS NOT NULL THEN
    EXECUTE $s43$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_products' AND k.conname = 'chk_inv_products_order_policy') THEN
    ALTER TABLE "public"."inv_products" ADD CONSTRAINT "chk_inv_products_order_policy" CHECK ((((min_order_qty IS NULL) OR (min_order_qty > (0)::numeric)) AND ((order_multiple IS NULL) OR (order_multiple > (0)::numeric))));
  END IF;
END $repair$
$s43$;
  END IF;
END $g43$;
--> statement-breakpoint
--
-- not-null constraints (18)
--
--> statement-breakpoint
DO $g45$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s45$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_id_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_id_not_null" NOT NULL id;
  END IF;
END $repair$
$s45$;
  END IF;
END $g45$;
--> statement-breakpoint
DO $g46$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s46$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_org_id_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s46$;
  END IF;
END $g46$;
--> statement-breakpoint
DO $g47$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s47$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_code_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_code_not_null" NOT NULL code;
  END IF;
END $repair$
$s47$;
  END IF;
END $g47$;
--> statement-breakpoint
DO $g48$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s48$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_name_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_name_not_null" NOT NULL name;
  END IF;
END $repair$
$s48$;
  END IF;
END $g48$;
--> statement-breakpoint
DO $g49$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s49$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_length_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_length_mm_not_null" NOT NULL inner_length_mm;
  END IF;
END $repair$
$s49$;
  END IF;
END $g49$;
--> statement-breakpoint
DO $g50$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s50$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_width_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_width_mm_not_null" NOT NULL inner_width_mm;
  END IF;
END $repair$
$s50$;
  END IF;
END $g50$;
--> statement-breakpoint
DO $g51$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s51$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_height_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_height_mm_not_null" NOT NULL inner_height_mm;
  END IF;
END $repair$
$s51$;
  END IF;
END $g51$;
--> statement-breakpoint
DO $g52$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s52$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_max_weight_grams_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_max_weight_grams_not_null" NOT NULL max_weight_grams;
  END IF;
END $repair$
$s52$;
  END IF;
END $g52$;
--> statement-breakpoint
DO $g53$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s53$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_is_active_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$
$s53$;
  END IF;
END $g53$;
--> statement-breakpoint
DO $g54$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s54$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_created_at_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$
$s54$;
  END IF;
END $g54$;
--> statement-breakpoint
DO $g55$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s55$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$
$s55$;
  END IF;
END $g55$;
--> statement-breakpoint
DO $g56$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s56$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_id_not_null" NOT NULL id;
  END IF;
END $repair$
$s56$;
  END IF;
END $g56$;
--> statement-breakpoint
DO $g57$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s57$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_org_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s57$;
  END IF;
END $g57$;
--> statement-breakpoint
DO $g58$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s58$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_shipment_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_shipment_id_not_null" NOT NULL shipment_id;
  END IF;
END $repair$
$s58$;
  END IF;
END $g58$;
--> statement-breakpoint
DO $g59$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s59$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_status_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_status_not_null" NOT NULL status;
  END IF;
END $repair$
$s59$;
  END IF;
END $g59$;
--> statement-breakpoint
DO $g60$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s60$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_occurred_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_occurred_at_not_null" NOT NULL occurred_at;
  END IF;
END $repair$
$s60$;
  END IF;
END $g60$;
--> statement-breakpoint
DO $g61$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s61$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_received_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_received_at_not_null" NOT NULL received_at;
  END IF;
END $repair$
$s61$;
  END IF;
END $g61$;
--> statement-breakpoint
DO $g62$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s62$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_created_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$
$s62$;
  END IF;
END $g62$;
--> statement-breakpoint
--
-- foreign keys (9)
--
--> statement-breakpoint
DO $g64$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL AND to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s64$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_pick_list_lines' AND k.conname = 'fk_inv_pick_lines_substitute_variant') THEN
    ALTER TABLE "public"."inv_pick_list_lines" ADD CONSTRAINT "fk_inv_pick_lines_substitute_variant" FOREIGN KEY (org_id, substitute_variant_id) REFERENCES inv_product_variants(org_id, id);
  END IF;
END $repair$
$s64$;
  END IF;
END $g64$;
--> statement-breakpoint
DO $g65$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s65$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_org_id_fkey') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s65$;
  END IF;
END $g65$;
--> statement-breakpoint
DO $g66$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL AND to_regclass('public."inv_packages"') IS NOT NULL THEN
    EXECUTE $s66$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_packages' AND k.conname = 'fk_inv_packages_carton_type') THEN
    ALTER TABLE "public"."inv_packages" ADD CONSTRAINT "fk_inv_packages_carton_type" FOREIGN KEY (org_id, carton_type_id) REFERENCES inv_carton_types(org_id, id);
  END IF;
END $repair$
$s66$;
  END IF;
END $g66$;
--> statement-breakpoint
DO $g67$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s67$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_org_id_fkey') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s67$;
  END IF;
END $g67$;
--> statement-breakpoint
DO $g68$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL AND to_regclass('public."inv_shipments"') IS NOT NULL THEN
    EXECUTE $s68$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'fk_inv_shipment_status_events_shipment') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "fk_inv_shipment_status_events_shipment" FOREIGN KEY (org_id, shipment_id) REFERENCES inv_shipments(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$
$s68$;
  END IF;
END $g68$;
--> statement-breakpoint
DO $g69$
BEGIN
  IF to_regclass('public."inv_customer_return_lines"') IS NOT NULL AND to_regclass('public."users"') IS NOT NULL THEN
    EXECUTE $s69$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_return_lines' AND k.conname = 'inv_customer_return_lines_inspected_by_fkey') THEN
    ALTER TABLE "public"."inv_customer_return_lines" ADD CONSTRAINT "inv_customer_return_lines_inspected_by_fkey" FOREIGN KEY (inspected_by) REFERENCES users(id);
  END IF;
END $repair$
$s69$;
  END IF;
END $g69$;
--> statement-breakpoint
DO $g70$
BEGIN
  IF to_regclass('public."inv_stock_transactions"') IS NOT NULL THEN
    EXECUTE $s70$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND k.conname = 'fk_inv_stock_transactions_correction_of_org') THEN
    ALTER TABLE "public"."inv_stock_transactions" ADD CONSTRAINT "fk_inv_stock_transactions_correction_of_org" FOREIGN KEY (org_id, correction_of_transaction_id) REFERENCES inv_stock_transactions(org_id, id) ON DELETE RESTRICT;
  END IF;
END $repair$
$s70$;
  END IF;
END $g70$;
--> statement-breakpoint
--
-- indexes (8)
--
--> statement-breakpoint
DO $g72$
BEGIN
  IF to_regclass('public."inv_grn_lines"') IS NOT NULL THEN
    EXECUTE $s72$
CREATE INDEX IF NOT EXISTS idx_inv_grn_lines_discrepancy ON public.inv_grn_lines USING btree (org_id, discrepancy_reason) WHERE (discrepancy_reason IS NOT NULL)
$s72$;
  END IF;
END $g72$;
--> statement-breakpoint
DO $g73$
BEGIN
  IF to_regclass('public."inv_pick_list_lines"') IS NOT NULL THEN
    EXECUTE $s73$
CREATE INDEX IF NOT EXISTS idx_inv_pick_lines_exception ON public.inv_pick_list_lines USING btree (org_id, exception_reason) WHERE (exception_reason IS NOT NULL)
$s73$;
  END IF;
END $g73$;
--> statement-breakpoint
DO $g74$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s74$
CREATE INDEX IF NOT EXISTS idx_inv_carton_types_org_active ON public.inv_carton_types USING btree (org_id, is_active)
$s74$;
  END IF;
END $g74$;
--> statement-breakpoint
DO $g75$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s75$
CREATE INDEX IF NOT EXISTS idx_inv_shipment_status_events_shipment ON public.inv_shipment_status_events USING btree (org_id, shipment_id, occurred_at DESC)
$s75$;
  END IF;
END $g75$;
--> statement-breakpoint
DO $g76$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s76$
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_shipment_status_events_carrier_event ON public.inv_shipment_status_events USING btree (org_id, carrier_id, carrier_event_id) NULLS NOT DISTINCT WHERE (carrier_event_id IS NOT NULL)
$s76$;
  END IF;
END $g76$;
--> statement-breakpoint
DO $g77$
BEGIN
  IF to_regclass('public."inv_customer_return_lines"') IS NOT NULL THEN
    EXECUTE $s77$
CREATE INDEX IF NOT EXISTS idx_inv_customer_return_lines_uninspected ON public.inv_customer_return_lines USING btree (org_id, return_id) WHERE (inspected_at IS NULL)
$s77$;
  END IF;
END $g77$;
--> statement-breakpoint
DO $g78$
BEGIN
  IF to_regclass('public."inv_stock_transactions"') IS NOT NULL THEN
    EXECUTE $s78$
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_stock_transactions_correction_of ON public.inv_stock_transactions USING btree (org_id, correction_of_transaction_id) WHERE (correction_of_transaction_id IS NOT NULL)
$s78$;
  END IF;
END $g78$;
--> statement-breakpoint
DO $g79$
BEGIN
  IF to_regclass('public."inv_stock_transactions"') IS NOT NULL THEN
    EXECUTE $s79$
CREATE INDEX IF NOT EXISTS idx_inv_stock_transactions_correction_source ON public.inv_stock_transactions USING btree (org_id, id) WHERE (correction_of_transaction_id IS NOT NULL)
$s79$;
  END IF;
END $g79$;
--> statement-breakpoint
--
-- triggers (1)
--
--> statement-breakpoint
DO $g81$
BEGIN
  IF to_regclass('public."inv_stock_transactions"') IS NOT NULL THEN
    EXECUTE $s81$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND t.tgname = 'trg_inv_stock_transactions_no_restatement') THEN
    CREATE TRIGGER trg_inv_stock_transactions_no_restatement BEFORE UPDATE ON public.inv_stock_transactions FOR EACH ROW EXECUTE FUNCTION inv_stock_transactions_no_restatement();
  END IF;
END $repair$
$s81$;
  END IF;
END $g81$;
--> statement-breakpoint
--
-- row-level security (2)
--
--> statement-breakpoint
DO $g83$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s83$
ALTER TABLE "public"."inv_carton_types" ENABLE ROW LEVEL SECURITY
$s83$;
  END IF;
END $g83$;
--> statement-breakpoint
DO $g84$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s84$
ALTER TABLE "public"."inv_shipment_status_events" ENABLE ROW LEVEL SECURITY
$s84$;
  END IF;
END $g84$;
--> statement-breakpoint
--
-- tenant isolation policies (2)
--
--> statement-breakpoint
DO $g86$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s86$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_carton_types' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_carton_types" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$
$s86$;
  END IF;
END $g86$;
--> statement-breakpoint
DO $g87$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s87$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_shipment_status_events' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_shipment_status_events" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$
$s87$;
  END IF;
END $g87$;
--> statement-breakpoint
--
-- sequence ownership (6)
--
--> statement-breakpoint
DO $g89$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s89$
ALTER SEQUENCE "public"."inv_carton_types_id_seq" OWNED BY "public"."inv_carton_types"."id"
$s89$;
  END IF;
END $g89$;
--> statement-breakpoint
DO $g90$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s90$
ALTER SEQUENCE "public"."inv_shipment_status_events_id_seq" OWNED BY "public"."inv_shipment_status_events"."id"
$s90$;
  END IF;
END $g90$;
--> statement-breakpoint
DO $g91$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s91$
ALTER SEQUENCE "public"."leads_id_seq1" OWNED BY "public"."leads"."id"
$s91$;
  END IF;
END $g91$;
--> statement-breakpoint
DO $g92$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s92$
ALTER SEQUENCE "public"."clients_id_seq1" OWNED BY "public"."clients"."id"
$s92$;
  END IF;
END $g92$;
--> statement-breakpoint
DO $g93$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s93$
ALTER SEQUENCE "public"."contacts_id_seq1" OWNED BY "public"."contacts"."id"
$s93$;
  END IF;
END $g93$;
--> statement-breakpoint
DO $g94$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s94$
ALTER SEQUENCE "public"."crm_organizations_id_seq1" OWNED BY "public"."crm_organizations"."id"
$s94$;
  END IF;
END $g94$;
--> statement-breakpoint
--
-- privileges on the tables this file creates (2)
--
--> statement-breakpoint
DO $g96$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s96$
REVOKE ALL ON "public"."inv_carton_types" FROM PUBLIC
$s96$;
  END IF;
END $g96$;
--> statement-breakpoint
DO $g97$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s97$
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_carton_types" TO "streamline_app"
$s97$;
  END IF;
END $g97$;
--> statement-breakpoint
DO $g98$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s98$
REVOKE ALL ON "public"."inv_shipment_status_events" FROM PUBLIC
$s98$;
  END IF;
END $g98$;
--> statement-breakpoint
DO $g99$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s99$
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_shipment_status_events" TO "streamline_app"
$s99$;
  END IF;
END $g99$;
