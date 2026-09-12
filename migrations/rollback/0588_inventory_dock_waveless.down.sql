-- 0588.down — Remove dock scheduling and waveless picking settings.
--
-- @data-loss: inv_dock_appointments, inv_dock_doors, inv_settings
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_dock_appointments" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_dock_doors" CASCADE;
--> statement-breakpoint
ALTER TABLE "inv_settings"
  DROP COLUMN IF EXISTS "waveless_picking",
  DROP COLUMN IF EXISTS "waveless_max_lines";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_dock_appointment_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_dock_direction";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
