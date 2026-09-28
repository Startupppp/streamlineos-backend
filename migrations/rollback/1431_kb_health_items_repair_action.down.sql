-- Rollback for 1431_kb_health_items_repair_action.sql
ALTER TABLE "public"."kb_health_items"
  DROP CONSTRAINT IF EXISTS "chk_kb_health_items_repair_action";

ALTER TABLE "public"."kb_health_items"
  DROP COLUMN IF EXISTS "repair_action";
