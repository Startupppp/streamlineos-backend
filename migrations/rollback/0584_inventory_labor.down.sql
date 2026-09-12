-- 0584.down — Remove labor records.
--
-- @data-loss: inv_labor_records
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_labor_records" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_labor_task_kind";
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE '0584.down: inv_labor_task_kind still has dependants; left in place.';
WHEN undefined_object THEN NULL;
END $$;
