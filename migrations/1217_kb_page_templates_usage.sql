-- 1217 — Usage tracking for saved KB page templates.
--
-- Adds use_count and last_used_at to kb_page_templates so the Templates UI can show
-- "use count" and "last used" per saved template (REQUIREMENT-LEDGER S12). Both columns
-- take a constant default, so this is a single fast metadata-only change — no backfill pass
-- is required.
--
-- HANDOFF: authored and NOT applied by lane L5. Once applied, wire
-- KbPageTemplatesService to increment use_count and set last_used_at at the point where a
-- template is used to create a page, and add both fields to kbPageTemplateSchema /
-- kb-templates-schema.ts. Do not deploy service code that selects these columns before
-- this migration is applied in the same environment — see MEMORY.md
-- "pending-migration-plus-live-call-site-is-a-deploy-landmine".
--
-- Rollback: migrations/rollback/1217_kb_page_templates_usage.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_page_templates') IS NULL THEN
    RAISE EXCEPTION '1217 precondition: public.kb_page_templates is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_templates"
  ADD COLUMN IF NOT EXISTS "use_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_templates"
  ADD COLUMN IF NOT EXISTS "last_used_at" timestamp;
