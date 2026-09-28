-- 1427 — Knowledge base: partial functional index on lower(title) for contradiction scanner.
--
-- B2 (content-health): the kb-contradiction-scan self-join uses
-- lower(p2.title) = lower(p1.title) as its join condition. Without an index
-- on lower(title), this is a full scan of all published pages in the org and
-- space on the inner side of the join — O(N) per row in the outer side, so
-- O(N²) overall for orgs with many same-space pages.
--
-- The partial expression index added here covers exactly the predicate the
-- scanner emits: org_id, space_id, lower(title) for published non-deleted rows.
-- With this index, the inner join becomes an index seek rather than a scan.
--
-- Why md5(content_text) is not indexed here: the scanner uses
--   md5(p2.content_text) IS DISTINCT FROM md5(p1.content_text)
-- as a post-filter to exclude identical content (so contradictory_claim does
-- not restate duplicate_candidate). This is a cross-row comparison that cannot
-- drive a standard index seek. After the lower(title) join narrows the candidate
-- set to same-title pairs, the md5 comparison is a cheap in-memory filter over
-- an already small result set. No additional index is warranted.
--
-- SCAN_BATCH = 50 (kb-contradiction-scanner.service.ts) bounds each per-org
-- sweep. The index does not change the bound; it only speeds up the join.
--
-- Replays on an empty DB: the precondition checks for kb_pages existence only.
-- If the table does not exist, the CREATE INDEX would fail 42P01 anyway.
--
-- Rollback: migrations/rollback/1427_kb_pages_contradiction_title_index.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1427 precondition: public.kb_pages is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_space_title_lower_published"
  ON "public"."kb_pages" ("org_id", "space_id", lower("title"))
  WHERE "deleted_at" IS NULL AND "status" = 'published';
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'kb_pages'
      AND indexname = 'idx_kb_pages_org_space_title_lower_published'
  ), '1427 post-check: idx_kb_pages_org_space_title_lower_published was not created';
END $$;
--> statement-breakpoint
