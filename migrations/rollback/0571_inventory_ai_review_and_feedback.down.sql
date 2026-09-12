-- 0571.down — Remove AI feedback and the insight review columns.
--
-- @data-loss: inv_ai_feedback, inv_ai_insights
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_ai_insights_org_wh_status";
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_ai_feedback" CASCADE;
--> statement-breakpoint
ALTER TABLE "inv_ai_insights"
  DROP COLUMN IF EXISTS "acknowledged_at",
  DROP COLUMN IF EXISTS "acknowledged_by",
  DROP COLUMN IF EXISTS "evidence_hash",
  DROP COLUMN IF EXISTS "resolution_note",
  DROP COLUMN IF EXISTS "warehouse_id",
  DROP COLUMN IF EXISTS "window_days";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_ai_feedback_verdict";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
