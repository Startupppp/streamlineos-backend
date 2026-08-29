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
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspected_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspected_by" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_return_lines" ADD COLUMN IF NOT EXISTS "inspection_notes" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_grn_lines" ADD COLUMN IF NOT EXISTS "quantity_expected" numeric(18,4);
--> statement-breakpoint
ALTER TABLE "public"."inv_grn_lines" ADD COLUMN IF NOT EXISTS "discrepancy_reason" inv_grn_discrepancy;
--> statement-breakpoint
ALTER TABLE "public"."inv_packages" ADD COLUMN IF NOT EXISTS "carton_type_id" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "exception_reason" inv_pick_exception;
--> statement-breakpoint
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "exception_notes" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "substitute_variant_id" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "substitute_quantity" numeric(18,4);
--> statement-breakpoint
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "weight_grams" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "length_mm" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "width_mm" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "height_mm" integer;
--> statement-breakpoint
ALTER TABLE "public"."inv_products" ADD COLUMN IF NOT EXISTS "min_order_qty" numeric(18,4);
--> statement-breakpoint
ALTER TABLE "public"."inv_products" ADD COLUMN IF NOT EXISTS "order_multiple" numeric(18,4);
--> statement-breakpoint
ALTER TABLE "public"."inv_settings" ADD COLUMN IF NOT EXISTS "po_approval_threshold" numeric(18,4);
--> statement-breakpoint
ALTER TABLE "public"."inv_stock_transactions" ADD COLUMN IF NOT EXISTS "correction_of_transaction_id" integer;
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
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_pkey') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'uniq_inv_carton_types_org_code') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "uniq_inv_carton_types_org_code" UNIQUE (org_id, code);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'uniq_inv_carton_types_org_id') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "uniq_inv_carton_types_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'chk_inv_carton_types_positive') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "chk_inv_carton_types_positive" CHECK (((inner_length_mm > 0) AND (inner_width_mm > 0) AND (inner_height_mm > 0) AND (max_weight_grams > 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_pkey') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_pick_list_lines' AND k.conname = 'chk_inv_pick_lines_substitute_pair') THEN
    ALTER TABLE "public"."inv_pick_list_lines" ADD CONSTRAINT "chk_inv_pick_lines_substitute_pair" CHECK ((((substitute_variant_id IS NULL) AND (substitute_quantity IS NULL)) OR ((substitute_variant_id IS NOT NULL) AND (substitute_quantity IS NOT NULL)))) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_products' AND k.conname = 'chk_inv_products_order_policy') THEN
    ALTER TABLE "public"."inv_products" ADD CONSTRAINT "chk_inv_products_order_policy" CHECK ((((min_order_qty IS NULL) OR (min_order_qty > (0)::numeric)) AND ((order_multiple IS NULL) OR (order_multiple > (0)::numeric))));
  END IF;
END $repair$;
--> statement-breakpoint
--
-- not-null constraints (18)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_id_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_org_id_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_code_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_name_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_length_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_length_mm_not_null" NOT NULL inner_length_mm;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_width_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_width_mm_not_null" NOT NULL inner_width_mm;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_inner_height_mm_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_inner_height_mm_not_null" NOT NULL inner_height_mm;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_max_weight_grams_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_max_weight_grams_not_null" NOT NULL max_weight_grams;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_is_active_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_created_at_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_org_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_shipment_id_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_shipment_id_not_null" NOT NULL shipment_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_status_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_occurred_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_occurred_at_not_null" NOT NULL occurred_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_received_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_received_at_not_null" NOT NULL received_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_created_at_not_null') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- foreign keys (9)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_pick_list_lines' AND k.conname = 'fk_inv_pick_lines_substitute_variant') THEN
    ALTER TABLE "public"."inv_pick_list_lines" ADD CONSTRAINT "fk_inv_pick_lines_substitute_variant" FOREIGN KEY (org_id, substitute_variant_id) REFERENCES inv_product_variants(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_carton_types' AND k.conname = 'inv_carton_types_org_id_fkey') THEN
    ALTER TABLE "public"."inv_carton_types" ADD CONSTRAINT "inv_carton_types_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_packages' AND k.conname = 'fk_inv_packages_carton_type') THEN
    ALTER TABLE "public"."inv_packages" ADD CONSTRAINT "fk_inv_packages_carton_type" FOREIGN KEY (org_id, carton_type_id) REFERENCES inv_carton_types(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'inv_shipment_status_events_org_id_fkey') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "inv_shipment_status_events_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_shipment_status_events' AND k.conname = 'fk_inv_shipment_status_events_shipment') THEN
    ALTER TABLE "public"."inv_shipment_status_events" ADD CONSTRAINT "fk_inv_shipment_status_events_shipment" FOREIGN KEY (org_id, shipment_id) REFERENCES inv_shipments(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_return_lines' AND k.conname = 'inv_customer_return_lines_inspected_by_fkey') THEN
    ALTER TABLE "public"."inv_customer_return_lines" ADD CONSTRAINT "inv_customer_return_lines_inspected_by_fkey" FOREIGN KEY (inspected_by) REFERENCES users(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND k.conname = 'fk_inv_stock_transactions_correction_of_org') THEN
    ALTER TABLE "public"."inv_stock_transactions" ADD CONSTRAINT "fk_inv_stock_transactions_correction_of_org" FOREIGN KEY (org_id, correction_of_transaction_id) REFERENCES inv_stock_transactions(org_id, id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- indexes (8)
--
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_grn_lines_discrepancy ON public.inv_grn_lines USING btree (org_id, discrepancy_reason) WHERE (discrepancy_reason IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_pick_lines_exception ON public.inv_pick_list_lines USING btree (org_id, exception_reason) WHERE (exception_reason IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_carton_types_org_active ON public.inv_carton_types USING btree (org_id, is_active);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_shipment_status_events_shipment ON public.inv_shipment_status_events USING btree (org_id, shipment_id, occurred_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_shipment_status_events_carrier_event ON public.inv_shipment_status_events USING btree (org_id, carrier_id, carrier_event_id) NULLS NOT DISTINCT WHERE (carrier_event_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_customer_return_lines_uninspected ON public.inv_customer_return_lines USING btree (org_id, return_id) WHERE (inspected_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_stock_transactions_correction_of ON public.inv_stock_transactions USING btree (org_id, correction_of_transaction_id) WHERE (correction_of_transaction_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_transactions_correction_source ON public.inv_stock_transactions USING btree (org_id, id) WHERE (correction_of_transaction_id IS NOT NULL);
--> statement-breakpoint
--
-- triggers (1)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND t.tgname = 'trg_inv_stock_transactions_no_restatement') THEN
    CREATE TRIGGER trg_inv_stock_transactions_no_restatement BEFORE UPDATE ON public.inv_stock_transactions FOR EACH ROW EXECUTE FUNCTION inv_stock_transactions_no_restatement();
  END IF;
END $repair$;
--> statement-breakpoint
--
-- row-level security (2)
--
--> statement-breakpoint
ALTER TABLE "public"."inv_carton_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."inv_shipment_status_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
--
-- tenant isolation policies (2)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_carton_types' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_carton_types" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_shipment_status_events' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_shipment_status_events" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
--
-- sequence ownership (6)
--
--> statement-breakpoint
ALTER SEQUENCE "public"."inv_carton_types_id_seq" OWNED BY "public"."inv_carton_types"."id";
--> statement-breakpoint
ALTER SEQUENCE "public"."inv_shipment_status_events_id_seq" OWNED BY "public"."inv_shipment_status_events"."id";
--> statement-breakpoint
ALTER SEQUENCE "public"."leads_id_seq1" OWNED BY "public"."leads"."id";
--> statement-breakpoint
ALTER SEQUENCE "public"."clients_id_seq1" OWNED BY "public"."clients"."id";
--> statement-breakpoint
ALTER SEQUENCE "public"."contacts_id_seq1" OWNED BY "public"."contacts"."id";
--> statement-breakpoint
ALTER SEQUENCE "public"."crm_organizations_id_seq1" OWNED BY "public"."crm_organizations"."id";
--> statement-breakpoint
--
-- privileges on the tables this file creates (2)
--
--> statement-breakpoint
REVOKE ALL ON "public"."inv_carton_types" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_carton_types" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_shipment_status_events" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_shipment_status_events" TO "streamline_app";
