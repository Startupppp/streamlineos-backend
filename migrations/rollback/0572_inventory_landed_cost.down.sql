-- 0572.down — Remove landed cost vouchers, charges and allocations.
--
-- Allocations reference valuation layers, so they go first. Reversing this does
-- not restore the pre-landed-cost unit costs on those layers: 0572's allocation
-- pass wrote into them, and dropping the allocation records leaves the adjusted
-- costs in place with nothing explaining them.
--
-- @data-loss: inv_landed_cost_vouchers, inv_landed_cost_charges, inv_landed_cost_allocations
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_landed_cost_allocations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_landed_cost_charges" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_landed_cost_vouchers" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_landed_cost_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_landed_cost_charge_type";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_landed_cost_basis";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
