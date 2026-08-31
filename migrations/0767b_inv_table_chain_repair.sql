-- Chain repair: 30 inv_* tables created with drizzle-kit push and never migrated.
--
-- The live database has these tables but pnpm db:migrate cannot build a fresh
-- database because no CREATE TABLE migration exists. Migration 0768 explicitly
-- checks for 14 of them and raises P0001 when absent, blocking every cold bootstrap.
--
-- All 30 push-created inv_* tables are reproduced here with full column/type/default
-- fidelity from pg_catalog. Every statement is idempotent (IF NOT EXISTS / guarded DO).
-- RLS is intentionally omitted -- 0768_rls_uncovered_tenant_tables handles that.
--
-- Placement: when=1798000079500, between 0767 (when=1798000079000) and
-- 0768 (when=1798000080000). The live DB watermark is 1798000131000,
-- so this entry is below-watermark on the live DB and requires a ledger backfill INSERT.
--
-- Generated from pg_catalog by src/scripts/emit-inv-tables.mjs.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
--
-- Phase 0: enum types and sequences required by the 30 push-created tables.
-- All guarded with IF NOT EXISTS so they are safe on the live DB where
-- these objects already exist from drizzle-kit push.
--
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_ai_feedback_verdict') THEN
    CREATE TYPE "public"."inv_ai_feedback_verdict" AS ENUM('USEFUL','WRONG','STALE','UNSAFE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_asn_status') THEN
    CREATE TYPE "public"."inv_asn_status" AS ENUM('DRAFT','CONFIRMED','IN_TRANSIT','ARRIVED','CLOSED','CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_channel_delivery_status') THEN
    CREATE TYPE "public"."inv_channel_delivery_status" AS ENUM('PENDING','PROCESSED','FAILED','DEAD');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_channel_snapshot_diff_status') THEN
    CREATE TYPE "public"."inv_channel_snapshot_diff_status" AS ENUM('OPEN','ACCEPTED','DISMISSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_dock_appointment_status') THEN
    CREATE TYPE "public"."inv_dock_appointment_status" AS ENUM('BOOKED','ARRIVED','COMPLETED','CANCELLED','NO_SHOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_dock_direction') THEN
    CREATE TYPE "public"."inv_dock_direction" AS ENUM('INBOUND','OUTBOUND');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_handling_unit_kind') THEN
    CREATE TYPE "public"."inv_handling_unit_kind" AS ENUM('PALLET','CARTON','CAGE','TOTE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_handling_unit_status') THEN
    CREATE TYPE "public"."inv_handling_unit_status" AS ENUM('OPEN','CLOSED','SHIPPED','EMPTY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_inspection_plan_version_status') THEN
    CREATE TYPE "public"."inv_inspection_plan_version_status" AS ENUM('DRAFT','ACTIVE','SUPERSEDED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_inspection_sampling_method') THEN
    CREATE TYPE "public"."inv_inspection_sampling_method" AS ENUM('ALL','PERCENTAGE','FIXED_QUANTITY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_labor_task_kind') THEN
    CREATE TYPE "public"."inv_labor_task_kind" AS ENUM('PICK','PUTAWAY','COUNT','RECEIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_landed_cost_basis') THEN
    CREATE TYPE "public"."inv_landed_cost_basis" AS ENUM('VALUE','QUANTITY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_landed_cost_charge_type') THEN
    CREATE TYPE "public"."inv_landed_cost_charge_type" AS ENUM('FREIGHT','DUTY','INSURANCE','HANDLING','OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_landed_cost_status') THEN
    CREATE TYPE "public"."inv_landed_cost_status" AS ENUM('DRAFT','APPLIED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_platform_po_status') THEN
    CREATE TYPE "public"."inv_platform_po_status" AS ENUM('RECEIVED','REJECTED','ACCEPTED','CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_putaway_disposition') THEN
    CREATE TYPE "public"."inv_putaway_disposition" AS ENUM('STORAGE','QUARANTINE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_putaway_status') THEN
    CREATE TYPE "public"."inv_putaway_status" AS ENUM('PENDING','IN_PROGRESS','COMPLETED','CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_qc_provider') THEN
    CREATE TYPE "public"."inv_qc_provider" AS ENUM('BLINKIT','INSTAMART','ZEPTO');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_slotting_match') THEN
    CREATE TYPE "public"."inv_slotting_match" AS ENUM('VELOCITY_CLASS','CATEGORY','PRODUCT_VARIANT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_slotting_recommendation_status') THEN
    CREATE TYPE "public"."inv_slotting_recommendation_status" AS ENUM('PENDING','APPROVED','DISMISSED','SUPERSEDED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='inv_velocity_class') THEN
    CREATE TYPE "public"."inv_velocity_class" AS ENUM('A','B','C');
  END IF;
END $$;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_ai_feedback_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_allocation_overrides_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_asn_lines_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_asns_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_channel_pools_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_customer_shelf_life_rules_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_demand_forecasts_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_dock_appointments_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_dock_doors_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_grn_line_serials_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_handling_units_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_inspection_plan_versions_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_inspection_plans_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_kit_components_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_labor_records_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_landed_cost_vouchers_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_platform_payout_lines_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_platform_po_lines_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_platform_purchase_orders_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_proposal_overrides_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_putaway_task_lines_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_putaway_tasks_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_slotting_recommendations_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_slotting_rules_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."inv_velocity_classes_id_seq" AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
--> statement-breakpoint
--
-- Phase 1: CREATE TABLE (all 30 inv_* tables)
--
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_ai_feedback" (
  "id" integer DEFAULT nextval('inv_ai_feedback_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "surface" text NOT NULL,
  "verdict" inv_ai_feedback_verdict NOT NULL,
  "feature" text NOT NULL,
  "prompt_key" text NOT NULL,
  "prompt_version" integer NOT NULL,
  "contract_version" integer NOT NULL,
  "model" text NOT NULL,
  "correlation_id" text NOT NULL,
  "evidence_hash" text,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "credits" integer DEFAULT 0 NOT NULL,
  "cost_micro_usd" integer DEFAULT 0 NOT NULL,
  "note" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_allocation_overrides" (
  "id" integer DEFAULT nextval('inv_allocation_overrides_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "reason" text NOT NULL,
  "verdict" text NOT NULL,
  "product_variant_id" integer NOT NULL,
  "lot_id" integer,
  "lot_number" text NOT NULL,
  "lot_expiry_date" date NOT NULL,
  "days_remaining" integer NOT NULL,
  "near_expiry_policy" text NOT NULL,
  "near_expiry_window_days" integer NOT NULL,
  "min_shelf_life_days" integer NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "client_id" integer,
  "reservation_id" integer,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_asn_lines" (
  "id" integer DEFAULT nextval('inv_asn_lines_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "asn_id" integer NOT NULL,
  "po_line_id" integer,
  "product_variant_id" integer NOT NULL,
  "quantity_expected" numeric(18,4) NOT NULL,
  "lot_number" text,
  "expiry_date" date,
  "mrp_paise" bigint,
  "line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_asns" (
  "id" integer DEFAULT nextval('inv_asns_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "asn_number" text NOT NULL,
  "platform_po_id" integer,
  "po_id" integer NOT NULL,
  "warehouse_id" integer,
  "location_id" integer,
  "status" inv_asn_status DEFAULT 'DRAFT'::inv_asn_status NOT NULL,
  "carrier_name" text,
  "tracking_ref" text,
  "appointment_start" timestamp without time zone,
  "appointment_end" timestamp without time zone,
  "expected_arrival" date,
  "notes" text,
  "metadata" jsonb,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_audit_export_jobs" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "status" inv_job_status DEFAULT 'PENDING'::inv_job_status NOT NULL,
  "schema_version" integer NOT NULL,
  "evidence_version" text NOT NULL,
  "ledger_ceiling_id" integer NOT NULL,
  "audit_ceiling_id" integer NOT NULL,
  "pinned_xmax" numeric(20,0) NOT NULL,
  "scope_warehouse_ids" jsonb,
  "sections" jsonb NOT NULL,
  "filter_from" date,
  "filter_to" date,
  "ledger_row_count" integer,
  "audit_row_count" integer,
  "checksum" text,
  "byte_length" bigint,
  "settled_at" timestamp without time zone,
  "failure_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_channel_pools" (
  "id" integer DEFAULT nextval('inv_channel_pools_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "warehouse_id" integer,
  "product_variant_id" integer NOT NULL,
  "reserved_qty" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "published_qty" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_channel_snapshot_diffs" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "delivery_id" integer,
  "product_variant_id" integer,
  "external_sku" text NOT NULL,
  "channel_qty" numeric(18,4) NOT NULL,
  "internal_qty" numeric(18,4) NOT NULL,
  "difference" numeric(18,4) NOT NULL,
  "status" inv_channel_snapshot_diff_status DEFAULT 'OPEN'::inv_channel_snapshot_diff_status NOT NULL,
  "snapshot_at" timestamp without time zone NOT NULL,
  "resolved_by" text,
  "resolved_at" timestamp without time zone,
  "resolution_note" text,
  "stock_transaction_id" integer,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_channel_webhook_deliveries" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "provider_delivery_id" text NOT NULL,
  "topic" text NOT NULL,
  "external_ref" text,
  "status" inv_channel_delivery_status DEFAULT 'PENDING'::inv_channel_delivery_status NOT NULL,
  "payload_digest" text NOT NULL,
  "delivery_metadata" jsonb,
  "received_at" timestamp without time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp without time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "lease_expires_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_customer_shelf_life_rules" (
  "id" integer DEFAULT nextval('inv_customer_shelf_life_rules_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "client_id" integer,
  "min_shelf_life_days" integer NOT NULL,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_demand_forecasts" (
  "id" integer DEFAULT nextval('inv_demand_forecasts_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "product_variant_id" integer NOT NULL,
  "warehouse_id" integer,
  "history_weeks" integer NOT NULL,
  "horizon_weeks" integer NOT NULL,
  "periods" integer NOT NULL,
  "coverage_from" date NOT NULL,
  "coverage_to" date NOT NULL,
  "method" text,
  "demand_category" text NOT NULL,
  "adi" numeric(18,4) NOT NULL,
  "cv2" numeric(18,4) NOT NULL,
  "season_length" integer,
  "mae" numeric(18,4),
  "rmse" numeric(18,4),
  "bias" numeric(18,4),
  "mase" numeric(18,4),
  "service_level" numeric(6,4) NOT NULL,
  "applicable" boolean NOT NULL,
  "refusal_reason" text,
  "safety_stock" numeric(18,4),
  "reorder_point" numeric(18,4),
  "lead_time_demand" numeric(18,4),
  "z" numeric(12,6),
  "demand_mean" numeric(18,4) NOT NULL,
  "demand_std_dev" numeric(18,4) NOT NULL,
  "lead_time_weeks" numeric(18,4) NOT NULL,
  "lead_time_std_dev_weeks" numeric(18,4) NOT NULL,
  "lead_time_observations" integer NOT NULL,
  "censored_periods" integer DEFAULT 0 NOT NULL,
  "stockout_censored" boolean DEFAULT false NOT NULL,
  "assumptions" jsonb NOT NULL,
  "input_fingerprint" text NOT NULL,
  "generated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "generated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_dock_appointments" (
  "id" integer DEFAULT nextval('inv_dock_appointments_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "door_id" integer NOT NULL,
  "direction" inv_dock_direction NOT NULL,
  "status" inv_dock_appointment_status DEFAULT 'BOOKED'::inv_dock_appointment_status NOT NULL,
  "window_start" timestamp without time zone NOT NULL,
  "window_end" timestamp without time zone NOT NULL,
  "carrier_name" text,
  "vehicle_ref" text,
  "reference" text,
  "asn_id" integer,
  "load_id" integer,
  "arrived_at" timestamp without time zone,
  "completed_at" timestamp without time zone,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_dock_doors" (
  "id" integer DEFAULT nextval('inv_dock_doors_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "code" text NOT NULL,
  "name" text,
  "direction" inv_dock_direction,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_grn_line_serials" (
  "id" integer DEFAULT nextval('inv_grn_line_serials_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "grn_line_id" integer NOT NULL,
  "serial_number" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_handling_units" (
  "id" integer DEFAULT nextval('inv_handling_units_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "hu_code" text NOT NULL,
  "kind" inv_handling_unit_kind DEFAULT 'PALLET'::inv_handling_unit_kind NOT NULL,
  "status" inv_handling_unit_status DEFAULT 'OPEN'::inv_handling_unit_status NOT NULL,
  "location_id" integer,
  "parent_hu_id" integer,
  "metadata" jsonb,
  "closed_at" timestamp without time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_inspection_plan_versions" (
  "id" integer DEFAULT nextval('inv_inspection_plan_versions_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" integer NOT NULL,
  "version" integer NOT NULL,
  "sampling_method" inv_inspection_sampling_method DEFAULT 'ALL'::inv_inspection_sampling_method NOT NULL,
  "sample_value" numeric(18,4),
  "instructions" text,
  "status" inv_inspection_plan_version_status DEFAULT 'DRAFT'::inv_inspection_plan_version_status NOT NULL,
  "activated_at" timestamp without time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_inspection_plans" (
  "id" integer DEFAULT nextval('inv_inspection_plans_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "product_variant_id" integer,
  "product_id" integer,
  "category_id" integer,
  "applies_on_receipt" boolean DEFAULT true NOT NULL,
  "applies_on_return" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_kit_components" (
  "id" integer DEFAULT nextval('inv_kit_components_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "kit_variant_id" integer NOT NULL,
  "component_variant_id" integer NOT NULL,
  "quantity_per" numeric(18,4) NOT NULL,
  "line_order" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_labor_records" (
  "id" integer DEFAULT nextval('inv_labor_records_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer,
  "task_kind" inv_labor_task_kind NOT NULL,
  "task_id" integer NOT NULL,
  "task_line_id" integer,
  "user_id" text NOT NULL,
  "location_id" integer,
  "started_at" timestamp without time zone NOT NULL,
  "completed_at" timestamp without time zone NOT NULL,
  "units_done" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "scan_count" integer DEFAULT 0 NOT NULL,
  "distance_proxy" integer DEFAULT 0 NOT NULL,
  "standard_seconds" integer NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_landed_cost_allocations" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "voucher_id" integer NOT NULL,
  "valuation_layer_id" integer,
  "product_variant_id" integer NOT NULL,
  "costing_method" text NOT NULL,
  "weight" numeric(18,4) NOT NULL,
  "allocated_value" numeric(18,4) NOT NULL,
  "capitalised_value" numeric(18,4) NOT NULL,
  "expensed_value" numeric(18,4) NOT NULL,
  "layer_quantity" numeric(18,4) NOT NULL,
  "remaining_quantity" numeric(18,4) NOT NULL,
  "unit_cost_before" numeric(18,4) NOT NULL,
  "unit_cost_after" numeric(18,4) NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_landed_cost_charges" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "voucher_id" integer NOT NULL,
  "charge_type" inv_landed_cost_charge_type NOT NULL,
  "description" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "vendor_id" integer,
  "reference" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_landed_cost_vouchers" (
  "id" integer DEFAULT nextval('inv_landed_cost_vouchers_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "grn_id" integer NOT NULL,
  "voucher_number" text NOT NULL,
  "status" inv_landed_cost_status DEFAULT 'DRAFT'::inv_landed_cost_status NOT NULL,
  "allocation_basis" inv_landed_cost_basis DEFAULT 'VALUE'::inv_landed_cost_basis NOT NULL,
  "currency" text DEFAULT 'INR'::text NOT NULL,
  "charge_total_cents" bigint DEFAULT 0 NOT NULL,
  "capitalised_value" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "expensed_value" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "notes" text,
  "applied_at" timestamp without time zone,
  "applied_by" text,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_platform_payout_lines" (
  "id" integer DEFAULT nextval('inv_platform_payout_lines_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "provider" inv_qc_provider NOT NULL,
  "payout_ref" text NOT NULL,
  "provider_po_number" text,
  "provider_sku" text,
  "ean" text,
  "quantity" numeric(18,4) NOT NULL,
  "amount_paise" bigint NOT NULL,
  "settled_on" date,
  "platform_po_line_id" integer,
  "unmatched_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_platform_po_lines" (
  "id" integer DEFAULT nextval('inv_platform_po_lines_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "platform_po_id" integer NOT NULL,
  "line_order" integer DEFAULT 0 NOT NULL,
  "provider_sku" text,
  "ean" text,
  "mrp_paise" bigint,
  "pack_size" integer,
  "quantity_ordered" numeric(18,4) NOT NULL,
  "unit_cost" numeric(18,4),
  "product_variant_id" integer,
  "validation_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_platform_purchase_orders" (
  "id" integer DEFAULT nextval('inv_platform_purchase_orders_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "provider" inv_qc_provider NOT NULL,
  "provider_po_number" text NOT NULL,
  "channel_id" integer,
  "warehouse_id" integer,
  "status" inv_platform_po_status DEFAULT 'RECEIVED'::inv_platform_po_status NOT NULL,
  "destination_ref" text,
  "ordered_at" timestamp without time zone,
  "expected_delivery_date" date,
  "currency" text DEFAULT 'INR'::text NOT NULL,
  "po_id" integer,
  "rejection_reason" text,
  "payload_digest" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_proposal_overrides" (
  "id" integer DEFAULT nextval('inv_proposal_overrides_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "forecast_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "warehouse_id" integer,
  "engine_qty" numeric(18,4) NOT NULL,
  "requested_qty" numeric(18,4) NOT NULL,
  "ordered_qty" numeric(18,4) NOT NULL,
  "reason" text NOT NULL,
  "po_id" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_putaway_task_lines" (
  "id" integer DEFAULT nextval('inv_putaway_task_lines_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "task_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "quantity_moved" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "disposition" inv_putaway_disposition DEFAULT 'STORAGE'::inv_putaway_disposition NOT NULL,
  "to_location_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_putaway_tasks" (
  "id" integer DEFAULT nextval('inv_putaway_tasks_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "task_number" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "grn_id" integer,
  "from_location_id" integer NOT NULL,
  "status" inv_putaway_status DEFAULT 'PENDING'::inv_putaway_status NOT NULL,
  "assigned_to" text,
  "claimed_at" timestamp without time zone,
  "completed_at" timestamp without time zone,
  "cancelled_at" timestamp without time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_slotting_recommendations" (
  "id" integer DEFAULT nextval('inv_slotting_recommendations_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "from_location_id" integer NOT NULL,
  "to_zone_location_id" integer NOT NULL,
  "quantity" numeric(18,4) NOT NULL,
  "rule_id" integer,
  "reason" text NOT NULL,
  "status" inv_slotting_recommendation_status DEFAULT 'PENDING'::inv_slotting_recommendation_status NOT NULL,
  "transfer_id" integer,
  "decided_by" text,
  "decided_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_slotting_rules" (
  "id" integer DEFAULT nextval('inv_slotting_rules_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "name" text NOT NULL,
  "match_type" inv_slotting_match NOT NULL,
  "velocity_class" inv_velocity_class,
  "category_id" integer,
  "product_variant_id" integer,
  "target_zone_location_id" integer NOT NULL,
  "target_location_type" inv_location_type,
  "priority" integer DEFAULT 100 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_velocity_classes" (
  "id" integer DEFAULT nextval('inv_velocity_classes_id_seq'::regclass) NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "velocity_class" inv_velocity_class NOT NULL,
  "pick_count" integer DEFAULT 0 NOT NULL,
  "issued_qty" numeric(18,4) DEFAULT '0'::numeric NOT NULL,
  "window_days" integer NOT NULL,
  "computed_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
--
-- Phase 2: primary key, unique and check constraints
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'chk_inv_ai_feedback_note') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "chk_inv_ai_feedback_note" CHECK ((((verdict <> ALL (ARRAY['WRONG'::inv_ai_feedback_verdict, 'UNSAFE'::inv_ai_feedback_verdict])) OR (char_length(btrim(COALESCE(note, ''::text))) >= 10)) AND (char_length(COALESCE(note, ''::text)) <= 1000) AND (total_tokens >= 0) AND (credits >= 0) AND (cost_micro_usd >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_contract_version_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_contract_version_not_null" NOT NULL contract_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_correlation_id_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_correlation_id_not_null" NOT NULL correlation_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_cost_micro_usd_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_cost_micro_usd_not_null" NOT NULL cost_micro_usd;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_created_at_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_credits_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_credits_not_null" NOT NULL credits;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_feature_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_feature_not_null" NOT NULL feature;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_id_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_model_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_model_not_null" NOT NULL model;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_org_id_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_prompt_key_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_prompt_key_not_null" NOT NULL prompt_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_prompt_version_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_prompt_version_not_null" NOT NULL prompt_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_surface_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_surface_not_null" NOT NULL surface;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_total_tokens_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_total_tokens_not_null" NOT NULL total_tokens;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_user_id_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_verdict_not_null') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_verdict_not_null" NOT NULL verdict;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'inv_ai_feedback_pkey') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "inv_ai_feedback_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'uniq_inv_ai_feedback_org_id') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "uniq_inv_ai_feedback_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'chk_inv_alloc_ovr_shape') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "chk_inv_alloc_ovr_shape" CHECK (((char_length(btrim(reason)) >= 3) AND (verdict = ANY (ARRAY['NEAR_EXPIRY'::text, 'SHELF_LIFE'::text])) AND (days_remaining >= 0) AND (near_expiry_window_days >= 0) AND (min_shelf_life_days >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_actor_user_id_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_actor_user_id_not_null" NOT NULL actor_user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_created_at_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_days_remaining_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_days_remaining_not_null" NOT NULL days_remaining;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_id_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_lot_expiry_date_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_lot_expiry_date_not_null" NOT NULL lot_expiry_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_lot_number_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_lot_number_not_null" NOT NULL lot_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_min_shelf_life_days_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_min_shelf_life_days_not_null" NOT NULL min_shelf_life_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_near_expiry_policy_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_near_expiry_policy_not_null" NOT NULL near_expiry_policy;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_near_expiry_window_days_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_near_expiry_window_days_not_null" NOT NULL near_expiry_window_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_org_id_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_reason_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_reason_not_null" NOT NULL reason;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_source_id_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_source_id_not_null" NOT NULL source_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_source_type_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_source_type_not_null" NOT NULL source_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_verdict_not_null') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_verdict_not_null" NOT NULL verdict;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'inv_allocation_overrides_pkey') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "inv_allocation_overrides_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'uniq_inv_allocation_overrides_org_id') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "uniq_inv_allocation_overrides_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'chk_inv_asn_lines_qty_positive') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "chk_inv_asn_lines_qty_positive" CHECK ((quantity_expected > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_asn_id_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_asn_id_not_null" NOT NULL asn_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_id_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_line_order_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_line_order_not_null" NOT NULL line_order;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_org_id_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_quantity_expected_not_null') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_quantity_expected_not_null" NOT NULL quantity_expected;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_pkey') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'uniq_inv_asn_lines_org_id') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "uniq_inv_asn_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'chk_inv_asns_appointment_window') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "chk_inv_asns_appointment_window" CHECK (((appointment_start IS NULL) OR (appointment_end IS NULL) OR (appointment_end > appointment_start)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_asn_number_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_asn_number_not_null" NOT NULL asn_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_created_at_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_created_by_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_id_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_org_id_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_po_id_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_po_id_not_null" NOT NULL po_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_status_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_pkey') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'uniq_inv_asns_org_id') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "uniq_inv_asns_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_audit_ceiling_id_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_audit_ceiling_id_not_null" NOT NULL audit_ceiling_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_created_at_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_created_by_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_evidence_version_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_evidence_version_not_null" NOT NULL evidence_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_id_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_ledger_ceiling_id_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_ledger_ceiling_id_not_null" NOT NULL ledger_ceiling_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_org_id_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_pinned_xmax_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_pinned_xmax_not_null" NOT NULL pinned_xmax;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_schema_version_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_schema_version_not_null" NOT NULL schema_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_sections_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_sections_not_null" NOT NULL sections;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_status_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_pkey') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'uniq_inv_audit_export_jobs_org_id') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "uniq_inv_audit_export_jobs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'chk_inv_channel_pools_published_nonneg') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "chk_inv_channel_pools_published_nonneg" CHECK ((published_qty >= (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'chk_inv_channel_pools_reserved_nonneg') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "chk_inv_channel_pools_reserved_nonneg" CHECK ((reserved_qty >= (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_channel_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_channel_id_not_null" NOT NULL channel_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_created_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_org_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_published_qty_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_published_qty_not_null" NOT NULL published_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_reserved_qty_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_reserved_qty_not_null" NOT NULL reserved_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_pkey') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'uniq_inv_channel_pools_org_id') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "uniq_inv_channel_pools_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'chk_inv_channel_diffs_difference') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "chk_inv_channel_diffs_difference" CHECK ((difference = (channel_qty - internal_qty)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'chk_inv_channel_diffs_resolution') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "chk_inv_channel_diffs_resolution" CHECK (((status = 'OPEN'::inv_channel_snapshot_diff_status) OR ((resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_channel_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_channel_id_not_null" NOT NULL channel_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_channel_qty_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_channel_qty_not_null" NOT NULL channel_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_created_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_difference_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_difference_not_null" NOT NULL difference;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_external_sku_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_external_sku_not_null" NOT NULL external_sku;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_internal_qty_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_internal_qty_not_null" NOT NULL internal_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_org_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_snapshot_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_snapshot_at_not_null" NOT NULL snapshot_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_status_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'inv_channel_snapshot_diffs_pkey') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "inv_channel_snapshot_diffs_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'uniq_inv_channel_snapshot_diffs_org_id') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "uniq_inv_channel_snapshot_diffs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_attempt_count_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_attempt_count_not_null" NOT NULL attempt_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_channel_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_channel_id_not_null" NOT NULL channel_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_created_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_org_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_payload_digest_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_payload_digest_not_null" NOT NULL payload_digest;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_provider_delivery_id_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_provider_delivery_id_not_null" NOT NULL provider_delivery_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_received_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_received_at_not_null" NOT NULL received_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_status_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_topic_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_topic_not_null" NOT NULL topic;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'inv_channel_webhook_deliveries_pkey') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "inv_channel_webhook_deliveries_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'uniq_inv_channel_delivery') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "uniq_inv_channel_delivery" UNIQUE (org_id, channel_id, provider_delivery_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'uniq_inv_channel_webhook_deliveries_org_id') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "uniq_inv_channel_webhook_deliveries_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'chk_inv_cslr_days') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "chk_inv_cslr_days" CHECK (((min_shelf_life_days >= 1) AND (min_shelf_life_days <= 3650)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_created_at_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_created_by_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_id_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_min_shelf_life_days_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_min_shelf_life_days_not_null" NOT NULL min_shelf_life_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_org_id_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'inv_customer_shelf_life_rules_pkey') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "inv_customer_shelf_life_rules_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'uniq_inv_cslr_org_id') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "uniq_inv_cslr_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'chk_inv_demand_forecasts_applicability') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "chk_inv_demand_forecasts_applicability" CHECK (((applicable AND (safety_stock IS NOT NULL) AND (reorder_point IS NOT NULL) AND (lead_time_demand IS NOT NULL)) OR ((NOT applicable) AND (safety_stock IS NULL) AND (reorder_point IS NULL) AND (lead_time_demand IS NULL) AND (refusal_reason IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'chk_inv_demand_forecasts_censoring') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "chk_inv_demand_forecasts_censoring" CHECK (((censored_periods >= 0) AND (censored_periods <= periods) AND (stockout_censored = (censored_periods > 0))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'chk_inv_demand_forecasts_window') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "chk_inv_demand_forecasts_window" CHECK (((service_level > (0)::numeric) AND (service_level < (1)::numeric) AND (history_weeks > 0) AND (horizon_weeks > 0) AND (periods >= 0) AND (coverage_to >= coverage_from)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_adi_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_adi_not_null" NOT NULL adi;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_applicable_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_applicable_not_null" NOT NULL applicable;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_assumptions_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_assumptions_not_null" NOT NULL assumptions;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_censored_periods_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_censored_periods_not_null" NOT NULL censored_periods;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_coverage_from_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_coverage_from_not_null" NOT NULL coverage_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_coverage_to_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_coverage_to_not_null" NOT NULL coverage_to;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_cv2_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_cv2_not_null" NOT NULL cv2;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_demand_category_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_demand_category_not_null" NOT NULL demand_category;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_demand_mean_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_demand_mean_not_null" NOT NULL demand_mean;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_demand_std_dev_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_demand_std_dev_not_null" NOT NULL demand_std_dev;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_generated_at_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_generated_at_not_null" NOT NULL generated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_generated_by_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_generated_by_not_null" NOT NULL generated_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_history_weeks_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_history_weeks_not_null" NOT NULL history_weeks;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_horizon_weeks_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_horizon_weeks_not_null" NOT NULL horizon_weeks;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_id_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_input_fingerprint_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_input_fingerprint_not_null" NOT NULL input_fingerprint;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_lead_time_observations_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_lead_time_observations_not_null" NOT NULL lead_time_observations;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_lead_time_std_dev_weeks_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_lead_time_std_dev_weeks_not_null" NOT NULL lead_time_std_dev_weeks;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_lead_time_weeks_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_lead_time_weeks_not_null" NOT NULL lead_time_weeks;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_org_id_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_periods_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_periods_not_null" NOT NULL periods;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_service_level_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_service_level_not_null" NOT NULL service_level;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_stockout_censored_not_null') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_stockout_censored_not_null" NOT NULL stockout_censored;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'inv_demand_forecasts_pkey') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "inv_demand_forecasts_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'uniq_inv_demand_forecasts_org_id') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "uniq_inv_demand_forecasts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'chk_inv_dock_appointments_arc') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "chk_inv_dock_appointments_arc" CHECK (((asn_id IS NULL) OR (load_id IS NULL)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'chk_inv_dock_appointments_window') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "chk_inv_dock_appointments_window" CHECK ((window_end > window_start));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_created_at_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_created_by_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_direction_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_direction_not_null" NOT NULL direction;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_door_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_door_id_not_null" NOT NULL door_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_org_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_status_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_window_end_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_window_end_not_null" NOT NULL window_end;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_window_start_not_null') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_window_start_not_null" NOT NULL window_start;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_pkey') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'uniq_inv_dock_appointments_org_id') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "uniq_inv_dock_appointments_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'excl_inv_dock_appointments_door_window') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "excl_inv_dock_appointments_door_window" EXCLUDE USING gist (org_id WITH =, door_id WITH =, tsrange(window_start, window_end, '[)'::text) WITH &&) WHERE ((status = ANY (ARRAY['BOOKED'::inv_dock_appointment_status, 'ARRIVED'::inv_dock_appointment_status, 'COMPLETED'::inv_dock_appointment_status])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_code_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_created_at_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_created_by_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_is_active_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_org_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_pkey') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'uniq_inv_dock_doors_org_id') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "uniq_inv_dock_doors_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_created_at_not_null') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_grn_line_id_not_null') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_grn_line_id_not_null" NOT NULL grn_line_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_id_not_null') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_org_id_not_null') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_serial_number_not_null') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_serial_number_not_null" NOT NULL serial_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_pkey') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'uniq_inv_grn_line_serials_org_id') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "uniq_inv_grn_line_serials_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'chk_inv_handling_units_not_self_parent') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "chk_inv_handling_units_not_self_parent" CHECK ((parent_hu_id IS DISTINCT FROM id));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'chk_inv_handling_units_placed_xor_nested') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "chk_inv_handling_units_placed_xor_nested" CHECK (((parent_hu_id IS NULL) OR (location_id IS NULL)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_created_at_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_created_by_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_hu_code_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_hu_code_not_null" NOT NULL hu_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_id_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_kind_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_org_id_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_status_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_pkey') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'uniq_inv_handling_units_org_id') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "uniq_inv_handling_units_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'chk_inv_inspection_plan_versions_sample') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "chk_inv_inspection_plan_versions_sample" CHECK ((((sampling_method = 'ALL'::inv_inspection_sampling_method) AND (sample_value IS NULL)) OR ((sampling_method = 'PERCENTAGE'::inv_inspection_sampling_method) AND (sample_value > (0)::numeric) AND (sample_value <= (100)::numeric)) OR ((sampling_method = 'FIXED_QUANTITY'::inv_inspection_sampling_method) AND (sample_value > (0)::numeric))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'chk_inv_inspection_plan_versions_version') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "chk_inv_inspection_plan_versions_version" CHECK ((version > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_created_at_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_created_by_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_id_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_org_id_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_plan_id_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_sampling_method_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_sampling_method_not_null" NOT NULL sampling_method;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_status_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_version_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_version_not_null" NOT NULL version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'inv_inspection_plan_versions_pkey') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "inv_inspection_plan_versions_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'uniq_inv_inspection_plan_versions_org_id') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "uniq_inv_inspection_plan_versions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'chk_inv_inspection_plans_scope') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "chk_inv_inspection_plans_scope" CHECK ((num_nonnulls(product_variant_id, product_id, category_id) <= 1));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'chk_inv_inspection_plans_trigger') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "chk_inv_inspection_plans_trigger" CHECK ((applies_on_receipt OR applies_on_return));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_applies_on_receipt_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_applies_on_receipt_not_null" NOT NULL applies_on_receipt;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_applies_on_return_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_applies_on_return_not_null" NOT NULL applies_on_return;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_code_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_created_at_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_created_by_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_id_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_is_active_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_name_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_org_id_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'inv_inspection_plans_pkey') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "inv_inspection_plans_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'uniq_inv_inspection_plans_org_id') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "uniq_inv_inspection_plans_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'chk_inv_kit_components_not_self') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "chk_inv_kit_components_not_self" CHECK ((kit_variant_id <> component_variant_id));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'chk_inv_kit_components_qty_positive') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "chk_inv_kit_components_qty_positive" CHECK ((quantity_per > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_component_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_component_variant_id_not_null" NOT NULL component_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_created_at_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_created_by_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_id_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_kit_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_kit_variant_id_not_null" NOT NULL kit_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_line_order_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_line_order_not_null" NOT NULL line_order;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_org_id_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_quantity_per_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_quantity_per_not_null" NOT NULL quantity_per;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_pkey') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'uniq_inv_kit_components_org_id') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "uniq_inv_kit_components_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'chk_inv_labor_records_standard_positive') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "chk_inv_labor_records_standard_positive" CHECK ((standard_seconds > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'chk_inv_labor_records_window') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "chk_inv_labor_records_window" CHECK ((completed_at >= started_at));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_completed_at_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_completed_at_not_null" NOT NULL completed_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_created_at_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_distance_proxy_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_distance_proxy_not_null" NOT NULL distance_proxy;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_id_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_org_id_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_scan_count_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_scan_count_not_null" NOT NULL scan_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_standard_seconds_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_standard_seconds_not_null" NOT NULL standard_seconds;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_started_at_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_started_at_not_null" NOT NULL started_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_task_id_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_task_id_not_null" NOT NULL task_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_task_kind_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_task_kind_not_null" NOT NULL task_kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_units_done_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_units_done_not_null" NOT NULL units_done;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_user_id_not_null') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_pkey') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'uniq_inv_labor_records_org_id') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "uniq_inv_labor_records_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'chk_inv_landed_cost_allocations_split') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "chk_inv_landed_cost_allocations_split" CHECK (((allocated_value = (capitalised_value + expensed_value)) AND (capitalised_value >= (0)::numeric) AND (expensed_value >= (0)::numeric) AND (remaining_quantity <= layer_quantity)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_allocated_value_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_allocated_value_not_null" NOT NULL allocated_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_capitalised_value_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_capitalised_value_not_null" NOT NULL capitalised_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_costing_method_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_costing_method_not_null" NOT NULL costing_method;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_created_at_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_expensed_value_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_expensed_value_not_null" NOT NULL expensed_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_layer_quantity_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_layer_quantity_not_null" NOT NULL layer_quantity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_org_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_remaining_quantity_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_remaining_quantity_not_null" NOT NULL remaining_quantity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_unit_cost_after_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_unit_cost_after_not_null" NOT NULL unit_cost_after;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_unit_cost_before_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_unit_cost_before_not_null" NOT NULL unit_cost_before;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_voucher_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_voucher_id_not_null" NOT NULL voucher_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_weight_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_weight_not_null" NOT NULL weight;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_pkey') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'uniq_inv_landed_cost_allocations_org_id') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "uniq_inv_landed_cost_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'chk_inv_landed_cost_charges_amount') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "chk_inv_landed_cost_charges_amount" CHECK (((amount_cents > 0) AND (char_length(btrim(description)) >= 1)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_amount_cents_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_amount_cents_not_null" NOT NULL amount_cents;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_charge_type_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_charge_type_not_null" NOT NULL charge_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_created_at_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_description_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_description_not_null" NOT NULL description;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_org_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_voucher_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_voucher_id_not_null" NOT NULL voucher_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_pkey') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'uniq_inv_landed_cost_charges_org_id') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "uniq_inv_landed_cost_charges_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_allocation_basis_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_allocation_basis_not_null" NOT NULL allocation_basis;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_capitalised_value_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_capitalised_value_not_null" NOT NULL capitalised_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_charge_total_cents_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_charge_total_cents_not_null" NOT NULL charge_total_cents;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_created_at_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_created_by_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_currency_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_expensed_value_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_expensed_value_not_null" NOT NULL expensed_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_grn_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_grn_id_not_null" NOT NULL grn_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_org_id_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_status_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_voucher_number_not_null') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_voucher_number_not_null" NOT NULL voucher_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_pkey') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'uniq_inv_landed_cost_vouchers_org_id') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "uniq_inv_landed_cost_vouchers_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'chk_inv_platform_payout_lines_qty_positive') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "chk_inv_platform_payout_lines_qty_positive" CHECK ((quantity > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_amount_paise_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_amount_paise_not_null" NOT NULL amount_paise;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_created_at_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_created_by_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_org_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_payout_ref_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_payout_ref_not_null" NOT NULL payout_ref;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_provider_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_provider_not_null" NOT NULL provider;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_quantity_not_null') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_quantity_not_null" NOT NULL quantity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_pkey') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'uniq_inv_platform_payout_lines_org_id') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "uniq_inv_platform_payout_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'chk_inv_platform_po_lines_qty_positive') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "chk_inv_platform_po_lines_qty_positive" CHECK ((quantity_ordered > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_line_order_not_null') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_line_order_not_null" NOT NULL line_order;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_org_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_platform_po_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_platform_po_id_not_null" NOT NULL platform_po_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_quantity_ordered_not_null') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_quantity_ordered_not_null" NOT NULL quantity_ordered;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_pkey') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'uniq_inv_platform_po_lines_org_id') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "uniq_inv_platform_po_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_created_at_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_created_by_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_currency_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_org_id_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_payload_digest_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_payload_digest_not_null" NOT NULL payload_digest;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_provider_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_provider_not_null" NOT NULL provider;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_provider_po_number_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_provider_po_number_not_null" NOT NULL provider_po_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_status_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_pkey') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'uniq_inv_platform_purchase_orders_org_id') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "uniq_inv_platform_purchase_orders_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'chk_inv_proposal_overrides_reason') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "chk_inv_proposal_overrides_reason" CHECK (((char_length(btrim(reason)) >= 10) AND (engine_qty >= (0)::numeric) AND (requested_qty > (0)::numeric) AND (ordered_qty > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_created_at_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_created_by_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_engine_qty_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_engine_qty_not_null" NOT NULL engine_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_forecast_id_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_forecast_id_not_null" NOT NULL forecast_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_id_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_ordered_qty_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_ordered_qty_not_null" NOT NULL ordered_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_org_id_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_po_id_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_po_id_not_null" NOT NULL po_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_reason_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_reason_not_null" NOT NULL reason;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_requested_qty_not_null') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_requested_qty_not_null" NOT NULL requested_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'inv_proposal_overrides_pkey') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "inv_proposal_overrides_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'uniq_inv_proposal_overrides_org_id') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "uniq_inv_proposal_overrides_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'chk_inv_putaway_task_lines_moved') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "chk_inv_putaway_task_lines_moved" CHECK (((quantity_moved >= (0)::numeric) AND (quantity_moved <= quantity)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'chk_inv_putaway_task_lines_quantity') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "chk_inv_putaway_task_lines_quantity" CHECK ((quantity > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_disposition_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_disposition_not_null" NOT NULL disposition;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_org_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_quantity_moved_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_quantity_moved_not_null" NOT NULL quantity_moved;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_quantity_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_quantity_not_null" NOT NULL quantity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_task_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_task_id_not_null" NOT NULL task_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'inv_putaway_task_lines_pkey') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "inv_putaway_task_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'uniq_inv_putaway_task_lines_org_id') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "uniq_inv_putaway_task_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'chk_inv_putaway_tasks_claim_pair') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "chk_inv_putaway_tasks_claim_pair" CHECK ((((assigned_to IS NULL) AND (claimed_at IS NULL)) OR ((assigned_to IS NOT NULL) AND (claimed_at IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_created_at_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_created_by_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_from_location_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_from_location_id_not_null" NOT NULL from_location_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_org_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_status_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_task_number_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_task_number_not_null" NOT NULL task_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'inv_putaway_tasks_pkey') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "inv_putaway_tasks_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'uniq_inv_putaway_tasks_org_id') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "uniq_inv_putaway_tasks_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'chk_inv_slotting_recommendations_qty_positive') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "chk_inv_slotting_recommendations_qty_positive" CHECK ((quantity > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_created_at_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_from_location_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_from_location_id_not_null" NOT NULL from_location_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_org_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_quantity_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_quantity_not_null" NOT NULL quantity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_reason_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_reason_not_null" NOT NULL reason;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_status_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_to_zone_location_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_to_zone_location_id_not_null" NOT NULL to_zone_location_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_pkey') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'uniq_inv_slotting_recommendations_org_id') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "uniq_inv_slotting_recommendations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'chk_inv_slotting_rules_match_payload') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "chk_inv_slotting_rules_match_payload" CHECK ((((match_type = 'VELOCITY_CLASS'::inv_slotting_match) AND (velocity_class IS NOT NULL) AND (category_id IS NULL) AND (product_variant_id IS NULL)) OR ((match_type = 'CATEGORY'::inv_slotting_match) AND (category_id IS NOT NULL) AND (velocity_class IS NULL) AND (product_variant_id IS NULL)) OR ((match_type = 'PRODUCT_VARIANT'::inv_slotting_match) AND (product_variant_id IS NOT NULL) AND (velocity_class IS NULL) AND (category_id IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_created_at_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_created_by_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_created_by_not_null" NOT NULL created_by;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_is_active_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_match_type_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_match_type_not_null" NOT NULL match_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_name_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_org_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_priority_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_priority_not_null" NOT NULL priority;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_target_zone_location_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_target_zone_location_id_not_null" NOT NULL target_zone_location_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_updated_at_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_pkey') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'uniq_inv_slotting_rules_org_id') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "uniq_inv_slotting_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_computed_at_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_computed_at_not_null" NOT NULL computed_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_id_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_issued_qty_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_issued_qty_not_null" NOT NULL issued_qty;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_org_id_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_pick_count_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_pick_count_not_null" NOT NULL pick_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_product_variant_id_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_product_variant_id_not_null" NOT NULL product_variant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_velocity_class_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_velocity_class_not_null" NOT NULL velocity_class;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_warehouse_id_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_warehouse_id_not_null" NOT NULL warehouse_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_window_days_not_null') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_window_days_not_null" NOT NULL window_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_pkey') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'uniq_inv_velocity_classes_org_id') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "uniq_inv_velocity_classes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
--
-- Phase 3: indexes
--
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_ai_feedback_org_surface ON public.inv_ai_feedback USING btree (org_id, surface, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_ai_feedback_org_verdict ON public.inv_ai_feedback USING btree (org_id, verdict, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_ai_feedback_org_user_call ON public.inv_ai_feedback USING btree (org_id, user_id, correlation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_alloc_ovr_org_client ON public.inv_allocation_overrides USING btree (org_id, client_id, created_at DESC) WHERE (client_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_alloc_ovr_org_created_id ON public.inv_allocation_overrides USING btree (org_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_alloc_ovr_org_lot ON public.inv_allocation_overrides USING btree (org_id, lot_id, created_at DESC) WHERE (lot_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_asn_lines_asn ON public.inv_asn_lines USING btree (org_id, asn_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_asns_org_po ON public.inv_asns USING btree (org_id, po_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_asns_org_status ON public.inv_asns USING btree (org_id, status, expected_arrival);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_asns_org_number ON public.inv_asns USING btree (org_id, asn_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_audit_export_jobs_org_created ON public.inv_audit_export_jobs USING btree (org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_audit_export_jobs_org_status ON public.inv_audit_export_jobs USING btree (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_channel_pools_org_channel ON public.inv_channel_pools USING btree (org_id, channel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_channel_pools_org_variant_warehouse ON public.inv_channel_pools USING btree (org_id, product_variant_id, warehouse_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_channel_pools_grain ON public.inv_channel_pools USING btree (org_id, channel_id, product_variant_id, COALESCE(warehouse_id, 0));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_channel_diffs_org_channel_status ON public.inv_channel_snapshot_diffs USING btree (org_id, channel_id, status, snapshot_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_channel_snapshot_diff_open ON public.inv_channel_snapshot_diffs USING btree (org_id, channel_id, external_sku) WHERE (status = 'OPEN'::inv_channel_snapshot_diff_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_channel_deliveries_org_status ON public.inv_channel_webhook_deliveries USING btree (org_id, status, received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_cslr_org_client ON public.inv_customer_shelf_life_rules USING btree (org_id, client_id) WHERE (client_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_cslr_org_house ON public.inv_customer_shelf_life_rules USING btree (org_id) WHERE (client_id IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_demand_forecasts_org_variant ON public.inv_demand_forecasts USING btree (org_id, product_variant_id, warehouse_id, generated_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_demand_forecasts_fingerprint ON public.inv_demand_forecasts USING btree (org_id, product_variant_id, warehouse_id, input_fingerprint) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_dock_appointments_org_asn ON public.inv_dock_appointments USING btree (org_id, asn_id) WHERE (asn_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_dock_appointments_org_door_window ON public.inv_dock_appointments USING btree (org_id, door_id, window_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_dock_appointments_org_warehouse_window ON public.inv_dock_appointments USING btree (org_id, warehouse_id, window_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_dock_doors_org_warehouse ON public.inv_dock_doors USING btree (org_id, warehouse_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_dock_doors_org_warehouse_code ON public.inv_dock_doors USING btree (org_id, warehouse_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_grn_line_serials_line ON public.inv_grn_line_serials USING btree (grn_line_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_grn_line_serials_line_number ON public.inv_grn_line_serials USING btree (org_id, grn_line_id, serial_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_handling_units_org_location ON public.inv_handling_units USING btree (org_id, location_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_handling_units_org_parent ON public.inv_handling_units USING btree (org_id, parent_hu_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_handling_units_org_status ON public.inv_handling_units USING btree (org_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_handling_units_org_code ON public.inv_handling_units USING btree (org_id, hu_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_inspection_plan_versions_plan ON public.inv_inspection_plan_versions USING btree (plan_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_inspection_plan_versions_active ON public.inv_inspection_plan_versions USING btree (org_id, plan_id) WHERE (status = 'ACTIVE'::inv_inspection_plan_version_status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_inspection_plan_versions_number ON public.inv_inspection_plan_versions USING btree (org_id, plan_id, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_inspection_plans_category ON public.inv_inspection_plans USING btree (org_id, category_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_inspection_plans_org_live ON public.inv_inspection_plans USING btree (org_id, is_active) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_inspection_plans_product ON public.inv_inspection_plans USING btree (org_id, product_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_inspection_plans_variant ON public.inv_inspection_plans USING btree (org_id, product_variant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_inspection_plans_org_code_live ON public.inv_inspection_plans USING btree (org_id, code) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_kit_components_org_component ON public.inv_kit_components USING btree (org_id, component_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_kit_components_org_kit ON public.inv_kit_components USING btree (org_id, kit_variant_id, line_order);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_kit_components_kit_component ON public.inv_kit_components USING btree (org_id, kit_variant_id, component_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_labor_records_org_task ON public.inv_labor_records USING btree (org_id, task_kind, task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_labor_records_org_user_completed ON public.inv_labor_records USING btree (org_id, user_id, completed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_labor_records_org_warehouse_completed ON public.inv_labor_records USING btree (org_id, warehouse_id, completed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_allocations_org_layer ON public.inv_landed_cost_allocations USING btree (org_id, valuation_layer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_allocations_org_voucher ON public.inv_landed_cost_allocations USING btree (org_id, voucher_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_landed_cost_allocations_voucher_layer ON public.inv_landed_cost_allocations USING btree (org_id, voucher_id, valuation_layer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_charges_org_voucher ON public.inv_landed_cost_charges USING btree (org_id, voucher_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_vouchers_org_grn ON public.inv_landed_cost_vouchers USING btree (org_id, grn_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_vouchers_org_status ON public.inv_landed_cost_vouchers USING btree (org_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_landed_cost_vouchers_org_number ON public.inv_landed_cost_vouchers USING btree (org_id, voucher_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_payout_org_provider_po ON public.inv_platform_payout_lines USING btree (org_id, provider, provider_po_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_payout_org_unmatched ON public.inv_platform_payout_lines USING btree (org_id, created_at) WHERE (platform_po_line_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_platform_payout_line_key ON public.inv_platform_payout_lines USING btree (org_id, provider, payout_ref, COALESCE(provider_po_number, ''::text), COALESCE(provider_sku, ean, ''::text));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_po_lines_po ON public.inv_platform_po_lines USING btree (org_id, platform_po_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_po_lines_variant ON public.inv_platform_po_lines USING btree (org_id, product_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_po_org_po ON public.inv_platform_purchase_orders USING btree (org_id, po_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_platform_po_org_status ON public.inv_platform_purchase_orders USING btree (org_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_platform_po_org_provider_number ON public.inv_platform_purchase_orders USING btree (org_id, provider, provider_po_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_proposal_overrides_org_forecast ON public.inv_proposal_overrides USING btree (org_id, forecast_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_proposal_overrides_org_po ON public.inv_proposal_overrides USING btree (org_id, po_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_putaway_task_lines_task ON public.inv_putaway_task_lines USING btree (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_putaway_task_lines_variant ON public.inv_putaway_task_lines USING btree (org_id, product_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_putaway_tasks_org_assignee ON public.inv_putaway_tasks USING btree (org_id, assigned_to, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_putaway_tasks_org_grn ON public.inv_putaway_tasks USING btree (org_id, grn_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_putaway_tasks_org_status ON public.inv_putaway_tasks USING btree (org_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_putaway_tasks_org_live_grn ON public.inv_putaway_tasks USING btree (org_id, grn_id) WHERE ((grn_id IS NOT NULL) AND (status <> 'CANCELLED'::inv_putaway_status));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_putaway_tasks_org_number ON public.inv_putaway_tasks USING btree (org_id, task_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_slotting_recommendations_org_status ON public.inv_slotting_recommendations USING btree (org_id, warehouse_id, status, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_slotting_recommendation_open ON public.inv_slotting_recommendations USING btree (org_id, product_variant_id, from_location_id) WHERE (status = 'PENDING'::inv_slotting_recommendation_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_slotting_rules_org_warehouse_active ON public.inv_slotting_rules USING btree (org_id, warehouse_id, priority) WHERE (is_active = true);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_slotting_rules_org_name ON public.inv_slotting_rules USING btree (org_id, warehouse_id, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_velocity_org_warehouse_class ON public.inv_velocity_classes USING btree (org_id, warehouse_id, velocity_class);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_velocity_org_warehouse_variant ON public.inv_velocity_classes USING btree (org_id, warehouse_id, product_variant_id);
--> statement-breakpoint
--
-- Phase 4: foreign keys (NOT VALID — binds new writes, skips historical scan)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'fk_inv_ai_feedback_org') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "fk_inv_ai_feedback_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_ai_feedback' AND k.conname = 'fk_inv_ai_feedback_user') THEN
    ALTER TABLE "public"."inv_ai_feedback" ADD CONSTRAINT "fk_inv_ai_feedback_user" FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_actor') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_actor" FOREIGN KEY (actor_user_id) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_client') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_client" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_client_org') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_client_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_lot') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_lot" FOREIGN KEY (lot_id) REFERENCES inv_lots(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_lot_org') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_lot_org" FOREIGN KEY (org_id, lot_id) REFERENCES inv_lots(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_org') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_reservation') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_reservation" FOREIGN KEY (reservation_id) REFERENCES inv_stock_reservations(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_reservation_org') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_reservation_org" FOREIGN KEY (org_id, reservation_id) REFERENCES inv_stock_reservations(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_variant') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_allocation_overrides' AND k.conname = 'fk_inv_alloc_ovr_variant_org') THEN
    ALTER TABLE "public"."inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'fk_inv_asn_lines_asn_org') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "fk_inv_asn_lines_asn_org" FOREIGN KEY (org_id, asn_id) REFERENCES inv_asns(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'fk_inv_asn_lines_variant_org') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "fk_inv_asn_lines_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asn_lines' AND k.conname = 'inv_asn_lines_po_line_id_inv_po_lines_id_fk') THEN
    ALTER TABLE "public"."inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_po_line_id_inv_po_lines_id_fk" FOREIGN KEY (po_line_id) REFERENCES inv_po_lines(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'fk_inv_asns_po_org') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "fk_inv_asns_po_org" FOREIGN KEY (org_id, po_id) REFERENCES inv_purchase_orders(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'fk_inv_asns_warehouse_org') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "fk_inv_asns_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE SET NULL (warehouse_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_location_id_inv_locations_id_fk') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_location_id_inv_locations_id_fk" FOREIGN KEY (location_id) REFERENCES inv_locations(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_asns' AND k.conname = 'inv_asns_platform_po_id_fk') THEN
    ALTER TABLE "public"."inv_asns" ADD CONSTRAINT "inv_asns_platform_po_id_fk" FOREIGN KEY (platform_po_id) REFERENCES inv_platform_purchase_orders(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_created_by_fk') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_created_by_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_audit_export_jobs' AND k.conname = 'inv_audit_export_jobs_org_id_fk') THEN
    ALTER TABLE "public"."inv_audit_export_jobs" ADD CONSTRAINT "inv_audit_export_jobs_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'fk_inv_channel_pools_channel_org') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_channel_org" FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'fk_inv_channel_pools_variant_org') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'fk_inv_channel_pools_warehouse_org') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_channel_id_inv_channels_id_fk') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_channel_id_inv_channels_id_fk" FOREIGN KEY (channel_id) REFERENCES inv_channels(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_product_variant_id_inv_product_variants_id_fk') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_pools' AND k.conname = 'inv_channel_pools_warehouse_id_inv_warehouses_id_fk') THEN
    ALTER TABLE "public"."inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_channel') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_channel" FOREIGN KEY (channel_id) REFERENCES inv_channels(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_channel_org') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_channel_org" FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_delivery_org') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_delivery_org" FOREIGN KEY (org_id, delivery_id) REFERENCES inv_channel_webhook_deliveries(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_org') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_resolved_by') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_resolved_by" FOREIGN KEY (resolved_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_txn_org') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_txn_org" FOREIGN KEY (org_id, stock_transaction_id) REFERENCES inv_stock_transactions(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_snapshot_diffs' AND k.conname = 'fk_inv_channel_diffs_variant_org') THEN
    ALTER TABLE "public"."inv_channel_snapshot_diffs" ADD CONSTRAINT "fk_inv_channel_diffs_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'fk_inv_channel_deliveries_channel') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "fk_inv_channel_deliveries_channel" FOREIGN KEY (channel_id) REFERENCES inv_channels(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'fk_inv_channel_deliveries_channel_org') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "fk_inv_channel_deliveries_channel_org" FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_channel_webhook_deliveries' AND k.conname = 'fk_inv_channel_deliveries_org') THEN
    ALTER TABLE "public"."inv_channel_webhook_deliveries" ADD CONSTRAINT "fk_inv_channel_deliveries_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'fk_inv_cslr_client') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_client" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'fk_inv_cslr_client_org') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_client_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'fk_inv_cslr_created_by') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_created_by" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_shelf_life_rules' AND k.conname = 'fk_inv_cslr_org') THEN
    ALTER TABLE "public"."inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_generated_by') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_generated_by" FOREIGN KEY (generated_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_org') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_variant') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_variant_org') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_warehouse') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_warehouse" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_demand_forecasts' AND k.conname = 'fk_inv_demand_forecasts_warehouse_org') THEN
    ALTER TABLE "public"."inv_demand_forecasts" ADD CONSTRAINT "fk_inv_demand_forecasts_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'fk_inv_dock_appointments_door_org') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "fk_inv_dock_appointments_door_org" FOREIGN KEY (org_id, door_id) REFERENCES inv_dock_doors(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'fk_inv_dock_appointments_warehouse_org') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "fk_inv_dock_appointments_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_asn_id_fk') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_asn_id_fk" FOREIGN KEY (asn_id) REFERENCES inv_asns(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_load_id_fk') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_load_id_fk" FOREIGN KEY (load_id) REFERENCES inv_loads(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_appointments' AND k.conname = 'inv_dock_appointments_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'fk_inv_dock_doors_warehouse_org') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "fk_inv_dock_doors_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_dock_doors' AND k.conname = 'inv_dock_doors_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'fk_inv_grn_line_serials_grn_line_id_org') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "fk_inv_grn_line_serials_grn_line_id_org" FOREIGN KEY (org_id, grn_line_id) REFERENCES inv_grn_lines(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_grn_line_id_fkey') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_grn_line_id_fkey" FOREIGN KEY (grn_line_id) REFERENCES inv_grn_lines(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_line_serials' AND k.conname = 'inv_grn_line_serials_org_id_fkey') THEN
    ALTER TABLE "public"."inv_grn_line_serials" ADD CONSTRAINT "inv_grn_line_serials_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'fk_inv_handling_units_location_org') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "fk_inv_handling_units_location_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) ON DELETE SET NULL (location_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'fk_inv_handling_units_parent_org') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "fk_inv_handling_units_parent_org" FOREIGN KEY (org_id, parent_hu_id) REFERENCES inv_handling_units(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_handling_units' AND k.conname = 'inv_handling_units_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_handling_units" ADD CONSTRAINT "inv_handling_units_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'fk_inv_inspection_plan_versions_created_by') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "fk_inv_inspection_plan_versions_created_by" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'fk_inv_inspection_plan_versions_org') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "fk_inv_inspection_plan_versions_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'fk_inv_inspection_plan_versions_plan') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "fk_inv_inspection_plan_versions_plan" FOREIGN KEY (plan_id) REFERENCES inv_inspection_plans(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plan_versions' AND k.conname = 'fk_inv_inspection_plan_versions_plan_id_org') THEN
    ALTER TABLE "public"."inv_inspection_plan_versions" ADD CONSTRAINT "fk_inv_inspection_plan_versions_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES inv_inspection_plans(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'fk_inv_inspection_plans_category') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "fk_inv_inspection_plans_category" FOREIGN KEY (category_id) REFERENCES inv_categories(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'fk_inv_inspection_plans_created_by') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "fk_inv_inspection_plans_created_by" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'fk_inv_inspection_plans_org') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "fk_inv_inspection_plans_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'fk_inv_inspection_plans_product') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "fk_inv_inspection_plans_product" FOREIGN KEY (product_id) REFERENCES inv_products(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_inspection_plans' AND k.conname = 'fk_inv_inspection_plans_variant') THEN
    ALTER TABLE "public"."inv_inspection_plans" ADD CONSTRAINT "fk_inv_inspection_plans_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'fk_inv_kit_components_component_org') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "fk_inv_kit_components_component_org" FOREIGN KEY (org_id, component_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'fk_inv_kit_components_kit_org') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "fk_inv_kit_components_kit_org" FOREIGN KEY (org_id, kit_variant_id) REFERENCES inv_product_variants(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_kit_components' AND k.conname = 'inv_kit_components_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_kit_components" ADD CONSTRAINT "inv_kit_components_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'fk_inv_labor_records_warehouse_org') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "fk_inv_labor_records_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_location_id_fk') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_location_id_fk" FOREIGN KEY (location_id) REFERENCES inv_locations(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_labor_records' AND k.conname = 'inv_labor_records_user_id_users_id_fk') THEN
    ALTER TABLE "public"."inv_labor_records" ADD CONSTRAINT "inv_labor_records_user_id_users_id_fk" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'fk_inv_landed_cost_allocations_layer_org') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "fk_inv_landed_cost_allocations_layer_org" FOREIGN KEY (org_id, valuation_layer_id) REFERENCES inv_valuation_layers(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'fk_inv_landed_cost_allocations_voucher_org') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "fk_inv_landed_cost_allocations_voucher_org" FOREIGN KEY (org_id, voucher_id) REFERENCES inv_landed_cost_vouchers(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'fk_inv_lc_allocations_layer') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "fk_inv_lc_allocations_layer" FOREIGN KEY (valuation_layer_id) REFERENCES inv_valuation_layers(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'fk_inv_lc_allocations_variant') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "fk_inv_lc_allocations_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'fk_inv_lc_allocations_voucher') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "fk_inv_lc_allocations_voucher" FOREIGN KEY (voucher_id) REFERENCES inv_landed_cost_vouchers(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_allocations' AND k.conname = 'inv_landed_cost_allocations_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_allocations" ADD CONSTRAINT "inv_landed_cost_allocations_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'fk_inv_landed_cost_charges_voucher_org') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "fk_inv_landed_cost_charges_voucher_org" FOREIGN KEY (org_id, voucher_id) REFERENCES inv_landed_cost_vouchers(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'fk_inv_lc_charges_voucher') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "fk_inv_lc_charges_voucher" FOREIGN KEY (voucher_id) REFERENCES inv_landed_cost_vouchers(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_charges' AND k.conname = 'inv_landed_cost_charges_vendor_id_inv_vendors_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_charges" ADD CONSTRAINT "inv_landed_cost_charges_vendor_id_inv_vendors_id_fk" FOREIGN KEY (vendor_id) REFERENCES inv_vendors(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'fk_inv_landed_cost_vouchers_grn_org') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "fk_inv_landed_cost_vouchers_grn_org" FOREIGN KEY (org_id, grn_id) REFERENCES inv_grns(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_applied_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_applied_by_users_id_fk" FOREIGN KEY (applied_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_grn_id_inv_grns_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_grn_id_inv_grns_id_fk" FOREIGN KEY (grn_id) REFERENCES inv_grns(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_landed_cost_vouchers' AND k.conname = 'inv_landed_cost_vouchers_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_landed_cost_vouchers" ADD CONSTRAINT "inv_landed_cost_vouchers_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'fk_inv_platform_payout_line_org') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "fk_inv_platform_payout_line_org" FOREIGN KEY (org_id, platform_po_line_id) REFERENCES inv_platform_po_lines(org_id, id) ON DELETE SET NULL (platform_po_line_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_payout_lines' AND k.conname = 'inv_platform_payout_lines_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'fk_inv_platform_po_lines_po_org') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "fk_inv_platform_po_lines_po_org" FOREIGN KEY (org_id, platform_po_id) REFERENCES inv_platform_purchase_orders(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'fk_inv_platform_po_lines_variant_org') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "fk_inv_platform_po_lines_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) ON DELETE SET NULL (product_variant_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_po_lines' AND k.conname = 'inv_platform_po_lines_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'fk_inv_platform_po_channel_org') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_channel_org" FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) ON DELETE SET NULL (channel_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'fk_inv_platform_po_po_org') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_po_org" FOREIGN KEY (org_id, po_id) REFERENCES inv_purchase_orders(org_id, id) ON DELETE SET NULL (po_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'fk_inv_platform_po_warehouse_org') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE SET NULL (warehouse_id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_platform_purchase_orders' AND k.conname = 'inv_platform_purchase_orders_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_created_by') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_created_by" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_forecast') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_forecast" FOREIGN KEY (forecast_id) REFERENCES inv_demand_forecasts(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_forecast_org') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_forecast_org" FOREIGN KEY (org_id, forecast_id) REFERENCES inv_demand_forecasts(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_org') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_po') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_po" FOREIGN KEY (po_id) REFERENCES inv_purchase_orders(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_po_org') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_po_org" FOREIGN KEY (org_id, po_id) REFERENCES inv_purchase_orders(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_variant') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_variant_org') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_warehouse') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_warehouse" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_proposal_overrides' AND k.conname = 'fk_inv_proposal_overrides_warehouse_org') THEN
    ALTER TABLE "public"."inv_proposal_overrides" ADD CONSTRAINT "fk_inv_proposal_overrides_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_lot') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_lot" FOREIGN KEY (lot_id) REFERENCES inv_lots(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_org') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_product_variant_id_org') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_serial') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_serial" FOREIGN KEY (serial_id) REFERENCES inv_serial_numbers(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_task') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_task" FOREIGN KEY (task_id) REFERENCES inv_putaway_tasks(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_task_id_org') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_task_id_org" FOREIGN KEY (org_id, task_id) REFERENCES inv_putaway_tasks(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_to_location') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_to_location" FOREIGN KEY (to_location_id) REFERENCES inv_locations(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_task_lines' AND k.conname = 'fk_inv_putaway_task_lines_variant') THEN
    ALTER TABLE "public"."inv_putaway_task_lines" ADD CONSTRAINT "fk_inv_putaway_task_lines_variant" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_assigned_to') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_assigned_to" FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_created_by') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_created_by" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_from_location') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_from_location" FOREIGN KEY (from_location_id) REFERENCES inv_locations(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_grn') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_grn" FOREIGN KEY (grn_id) REFERENCES inv_grns(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_org') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_putaway_tasks' AND k.conname = 'fk_inv_putaway_tasks_warehouse') THEN
    ALTER TABLE "public"."inv_putaway_tasks" ADD CONSTRAINT "fk_inv_putaway_tasks_warehouse" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'fk_inv_slotting_recommendation_variant_org') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "fk_inv_slotting_recommendation_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_decided_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_decided_by_users_id_fk" FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_from_location_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_from_location_id_fk" FOREIGN KEY (from_location_id) REFERENCES inv_locations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_rule_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_rule_id_fk" FOREIGN KEY (rule_id) REFERENCES inv_slotting_rules(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_to_zone_location_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_to_zone_location_id_fk" FOREIGN KEY (to_zone_location_id) REFERENCES inv_locations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_recommendations' AND k.conname = 'inv_slotting_recommendations_warehouse_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_warehouse_id_fk" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'fk_inv_slotting_rules_warehouse_org') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "fk_inv_slotting_rules_warehouse_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'fk_inv_slotting_rules_zone_org') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "fk_inv_slotting_rules_zone_org" FOREIGN KEY (org_id, target_zone_location_id) REFERENCES inv_locations(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_category_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_category_id_fk" FOREIGN KEY (category_id) REFERENCES inv_categories(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_created_by_users_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_slotting_rules' AND k.conname = 'inv_slotting_rules_product_variant_id_fk') THEN
    ALTER TABLE "public"."inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_product_variant_id_fk" FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'fk_inv_velocity_variant_org') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "fk_inv_velocity_variant_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_velocity_classes' AND k.conname = 'inv_velocity_classes_warehouse_id_fk') THEN
    ALTER TABLE "public"."inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_warehouse_id_fk" FOREIGN KEY (warehouse_id) REFERENCES inv_warehouses(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- Phase 5: app role grants
--
--> statement-breakpoint
REVOKE ALL ON "public"."inv_ai_feedback" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_ai_feedback" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_allocation_overrides" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_allocation_overrides" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_asn_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_asn_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_asns" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_asns" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_audit_export_jobs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_audit_export_jobs" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_channel_pools" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_channel_pools" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_channel_snapshot_diffs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_channel_snapshot_diffs" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_channel_webhook_deliveries" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_channel_webhook_deliveries" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_customer_shelf_life_rules" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_customer_shelf_life_rules" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_demand_forecasts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_demand_forecasts" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_dock_appointments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_dock_appointments" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_dock_doors" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_dock_doors" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_grn_line_serials" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_grn_line_serials" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_handling_units" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_handling_units" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_inspection_plan_versions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_inspection_plan_versions" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_inspection_plans" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_inspection_plans" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_kit_components" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_kit_components" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_labor_records" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_labor_records" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_landed_cost_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_landed_cost_allocations" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_landed_cost_charges" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_landed_cost_charges" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_landed_cost_vouchers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_landed_cost_vouchers" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_platform_payout_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_platform_payout_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_platform_po_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_platform_po_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_platform_purchase_orders" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_platform_purchase_orders" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_proposal_overrides" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_proposal_overrides" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_putaway_task_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_putaway_task_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_putaway_tasks" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_putaway_tasks" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_slotting_recommendations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_slotting_recommendations" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_slotting_rules" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_slotting_rules" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_velocity_classes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_velocity_classes" TO "streamline_app";
