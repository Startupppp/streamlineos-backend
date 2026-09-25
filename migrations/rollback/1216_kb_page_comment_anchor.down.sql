-- Rollback for 1216_kb_page_comment_anchor
-- Drops the anchor_block_index and anchor_quote columns from kb_page_comments.
-- Safe to run only while no application code reads or writes either column.
SET lock_timeout = '5s';

ALTER TABLE "public"."kb_page_comments" DROP CONSTRAINT IF EXISTS "chk_kb_page_comments_anchor_block_index_nonneg";
ALTER TABLE "public"."kb_page_comments" DROP COLUMN IF EXISTS "anchor_quote";
ALTER TABLE "public"."kb_page_comments" DROP COLUMN IF EXISTS "anchor_block_index";
