-- 0583.down — Remove slotting rules, velocity classes and recommendations.
--
-- @data-loss: inv_slotting_rules, inv_slotting_recommendations, inv_velocity_classes
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_slotting_recommendations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_slotting_rules" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_velocity_classes" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_slotting_recommendation_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_slotting_match";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_velocity_class";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
