-- Rollback for 1217_kb_page_templates_usage
-- Drops the use_count and last_used_at columns from kb_page_templates.
-- Safe to run only while no application code reads or writes either column.
SET lock_timeout = '5s';

ALTER TABLE "public"."kb_page_templates" DROP COLUMN IF EXISTS "last_used_at";
ALTER TABLE "public"."kb_page_templates" DROP COLUMN IF EXISTS "use_count";
