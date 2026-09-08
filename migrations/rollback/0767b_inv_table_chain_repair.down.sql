-- 0767b.down — Drop the 30 tables this chain repair created.
--
-- 0767b exists because a run of migrations assumed tables that no migration had
-- created. Its inverse is to drop them. CASCADE is deliberate: later migrations
-- attach policies, indexes and foreign keys to several of these, and at head
-- those dependants still exist.
--
-- Generated from the forward migration's own CREATE TABLE list, so the two
-- cannot drift.
--
-- @data-loss: inv_ai_feedback, inv_allocation_overrides, inv_asn_lines, inv_asns, inv_audit_export_jobs, inv_channel_pools, inv_channel_snapshot_diffs, inv_channel_webhook_deliveries, inv_customer_shelf_life_rules, inv_demand_forecasts, ...
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_velocity_classes" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_slotting_rules" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_slotting_recommendations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_putaway_tasks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_putaway_task_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_proposal_overrides" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_platform_purchase_orders" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_platform_po_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_platform_payout_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_landed_cost_vouchers" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_landed_cost_charges" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_landed_cost_allocations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_labor_records" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_kit_components" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_inspection_plans" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_inspection_plan_versions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_handling_units" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_grn_line_serials" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_dock_doors" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_dock_appointments" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_demand_forecasts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_customer_shelf_life_rules" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_channel_webhook_deliveries" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_channel_snapshot_diffs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_channel_pools" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_audit_export_jobs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_asns" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_asn_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_allocation_overrides" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."inv_ai_feedback" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "public";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
