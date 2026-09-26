-- 1216 — Anchor a page comment to a specific content block.
--
-- Adds anchor_block_index and anchor_quote to kb_page_comments so a top-level comment can
-- point at a specific block in the page's content (REQUIREMENT-LEDGER S08 "anchored
-- comments"). Both columns are nullable — every existing row and every page-level comment
-- with no anchor stays valid. kb-page-comments.service.ts rejects an anchor on a reply
-- (parentId set); a reply inherits its thread's anchor rather than carrying its own.
--
-- HANDOFF: authored and NOT applied by lane L4. kb-page-comments.service.ts's create()
-- already writes anchor_block_index/anchor_quote in the same change that adds this
-- migration. Apply this migration BEFORE that service code reaches production — Railway
-- deploys the backend on every push, so an unapplied migration plus a live call site is an
-- outage on every comment creation. See MEMORY.md
-- "pending-migration-plus-live-call-site-is-a-deploy-landmine".
--
-- Rollback: migrations/rollback/1216_kb_page_comment_anchor.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_page_comments') IS NULL THEN
    RAISE EXCEPTION '1216 precondition: public.kb_page_comments is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_comments"
  ADD COLUMN IF NOT EXISTS "anchor_block_index" integer;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_comments"
  ADD COLUMN IF NOT EXISTS "anchor_quote" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_comments"
  DROP CONSTRAINT IF EXISTS "chk_kb_page_comments_anchor_block_index_nonneg";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_comments"
  ADD CONSTRAINT "chk_kb_page_comments_anchor_block_index_nonneg"
  CHECK ("anchor_block_index" IS NULL OR "anchor_block_index" >= 0) NOT VALID;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_comments"
  VALIDATE CONSTRAINT "chk_kb_page_comments_anchor_block_index_nonneg";
