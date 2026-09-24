-- @data-loss
-- Retires the kb_articles family. Four of its dependent tables are RENAMED into
-- page-scoped tables (their rows and grants travel with them); four are DROPPED
-- because kb_pages already carries an equivalent.
--
--   kb_article_tags          -> kb_page_tags           (renamed)
--   kb_article_translations  -> kb_page_translations   (renamed)
--   kb_article_feedback      -> kb_page_feedback       (renamed)
--   kb_article_restrictions  -> kb_page_restrictions   (renamed)
--   kb_article_versions      -> kb_page_versions       (dropped; equivalent exists)
--   kb_article_comments      -> kb_page_comments       (dropped; equivalent exists)
--   kb_article_attachments   -> kb_page_attachments    (dropped; equivalent exists)
--   kb_articles              -> kb_pages               (dropped; 1173 backfilled it)
--
-- The three "equivalent exists" drops are lossless only while those tables are
-- empty, so the preflight below REFUSES TO RUN if any of them holds a row. A
-- row-copy for them is deliberately not written here: kb_article_comments has a
-- self-referential parent_id whose ids would have to be remapped, and an
-- untested remap is worse than a loud failure. If a future environment has rows,
-- write and test the copy then.
--
-- The parity preflight kept from the original revision answers "does every
-- article have a page?". At zero article rows it answers itself, so it is a
-- guard against regression, not evidence of a completed backfill.
--
-- The precondition that actually governs this migration has no SQL form: no
-- deployed code may still read kb_articles. Apply this only after the backend
-- that reads kb_pages is the one running.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  unmatched_count     integer;
  col_mismatch_count  integer;
  occupied            text;
  already_taken       text;
  anchored_chunks     integer;
BEGIN
  IF to_regclass('public.kb_articles') IS NULL THEN
    RAISE EXCEPTION '1174 precondition: public.kb_articles is absent — was 1174 already applied?';
  END IF;

  IF to_regclass('public.kb_pages') IS NULL
     OR to_regclass('public.kb_page_versions') IS NULL
     OR to_regclass('public.kb_page_comments') IS NULL
     OR to_regclass('public.kb_page_attachments') IS NULL THEN
    RAISE EXCEPTION '1174 precondition: the page-side destination tables are not all present — 1173 and the wiki migrations must land first';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO already_taken
  FROM (VALUES
    ('kb_page_tags'), ('kb_page_translations'),
    ('kb_page_feedback'), ('kb_page_restrictions')
  ) AS t(name)
  WHERE to_regclass('public.' || name) IS NOT NULL;

  IF already_taken IS NOT NULL THEN
    RAISE EXCEPTION '1174 precondition: % already exist(s) — the rename cannot claim a name that is taken', already_taken;
  END IF;

  SELECT count(*) INTO unmatched_count
  FROM "public"."kb_articles" a
  WHERE NOT EXISTS (
    SELECT 1 FROM "public"."kb_pages" p
    WHERE p.org_id = a.org_id
      AND p.source_article_id = a.id
  );

  IF unmatched_count > 0 THEN
    RAISE EXCEPTION '1174 precondition: % kb_articles row(s) have no matching kb_pages row — run 1173 and verify parity before this migration', unmatched_count;
  END IF;

  SELECT count(*) INTO col_mismatch_count
  FROM "public"."kb_articles" a
  JOIN "public"."kb_pages" p
    ON p.org_id = a.org_id AND p.source_article_id = a.id
  WHERE a.slug               IS DISTINCT FROM p.slug
     OR a.title              IS DISTINCT FROM p.title
     OR a.excerpt            IS DISTINCT FROM p.excerpt
     OR a.views              IS DISTINCT FROM p.views
     OR a.helpful_count      IS DISTINCT FROM p.helpful_count
     OR a.not_helpful_count  IS DISTINCT FROM p.not_helpful_count
     OR a.seo_title          IS DISTINCT FROM p.seo_title
     OR a.seo_description    IS DISTINCT FROM p.seo_description
     OR a.review_interval_days IS DISTINCT FROM p.review_interval_days
     OR a.published_at       IS DISTINCT FROM p.published_at
     OR a.archived_at        IS DISTINCT FROM p.archived_at;

  IF col_mismatch_count > 0 THEN
    RAISE EXCEPTION '1174 precondition: % article/page pair(s) have column-level mismatches — run verify/1173_kb_articles_cutover_parity.sql to identify them', col_mismatch_count;
  END IF;

  SELECT string_agg(format('%s (%s rows)', name, n), ', ' ORDER BY name) INTO occupied
  FROM (
    SELECT 'kb_article_versions'    AS name, (SELECT count(*) FROM "public"."kb_article_versions")    AS n
    UNION ALL
    SELECT 'kb_article_comments',          (SELECT count(*) FROM "public"."kb_article_comments")
    UNION ALL
    SELECT 'kb_article_attachments',       (SELECT count(*) FROM "public"."kb_article_attachments")
  ) AS counted
  WHERE n > 0;

  IF occupied IS NOT NULL THEN
    RAISE EXCEPTION '1174 precondition: % still hold(s) rows — this migration drops them without a row-copy, so it would lose data. Write and test a copy into the kb_page_* equivalents first.', occupied;
  END IF;

  SELECT count(*) INTO anchored_chunks
  FROM "public"."kb_article_chunks"
  WHERE attachment_id IS NOT NULL;

  IF anchored_chunks > 0 THEN
    RAISE EXCEPTION '1174 precondition: % kb_article_chunks row(s) point at a kb_article_attachments id that is about to disappear — re-anchor or delete them first', anchored_chunks;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_versions"
  ADD COLUMN IF NOT EXISTS "excerpt" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_attachments"
  ADD COLUMN IF NOT EXISTS "file_url" text;
--> statement-breakpoint

-- kb_articles.last_verified_at stored WHEN an article was verified. kb_pages has
-- verified_until, verified_by_id and trust_state but never recorded the instant,
-- so the help centre would have to derive lastVerifiedAt by subtracting a fixed
-- window from verified_until. That subtraction is only exact when the window it
-- assumes matches the one that wrote the row, and two paths write this column
-- with different windows: the help-centre verify uses 180 days, the wiki verify
-- uses computeVerificationInterval (120 days for support_article). An article
-- verified through the wiki surface would report lastVerifiedAt 60 days early,
-- and an expired article would report null where kb_articles kept the date.
-- lastVerifiedAt is a published response field, so this stores the fact instead.
-- Measured immediately before writing this: kb_pages holds 20 rows, 0 verified
-- and 0 with verified_until, so there is nothing to backfill.
ALTER TABLE "public"."kb_pages"
  ADD COLUMN IF NOT EXISTS "verified_at" timestamptz;
--> statement-breakpoint

-- kb_articles declared these three NOT NULL; kb_pages declares them nullable
-- with a default of 0. Moving the help centre onto kb_pages would quietly drop
-- the guarantee, and `col + 1` over a NULL yields NULL, so a single null counter
-- silently swallows every subsequent vote on that page.
--
-- The staged form BE-63 asks for (CHECK NOT VALID, VALIDATE, SET NOT NULL)
-- exists to avoid holding ACCESS EXCLUSIVE through a full-table scan. Measured
-- immediately before writing this: kb_pages holds 20 rows, 0 of them null in
-- any of the three columns, so the direct form takes the lock for microseconds
-- and needs no backfill. lock_timeout is set above and will fail fast if that
-- ever stops being true.
ALTER TABLE "public"."kb_pages" ALTER COLUMN "views" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ALTER COLUMN "helpful_count" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ALTER COLUMN "not_helpful_count" SET NOT NULL;
--> statement-breakpoint

-- kb_article_tags -> kb_page_tags.
-- The UPDATE rewrites article ids into page ids while the column still carries
-- its old name; it is a no-op at zero rows and the FK added afterwards is what
-- proves the rewrite was complete.
ALTER TABLE "public"."kb_article_tags"
  DROP CONSTRAINT IF EXISTS "fk_kb_article_tags_org_article";
--> statement-breakpoint

UPDATE "public"."kb_article_tags" t
SET "article_id" = p."id"
FROM "public"."kb_pages" p
WHERE p."org_id" = t."org_id"
  AND p."source_article_id" = t."article_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_tags" RENAME COLUMN "article_id" TO "page_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_tags" RENAME TO "kb_page_tags";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_tags"
  RENAME CONSTRAINT "kb_article_tags_org_id_article_id_tag_id_pk" TO "kb_page_tags_org_id_page_id_tag_id_pk";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_tags"
  RENAME CONSTRAINT "fk_kb_article_tags_org_tag" TO "fk_kb_page_tags_org_tag";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_tags"
  RENAME CONSTRAINT "kb_article_tags_org_id_fkey" TO "kb_page_tags_org_id_fkey";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_tags_org_tag" RENAME TO "idx_kb_page_tags_org_tag";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_tags"
  ADD CONSTRAINT "fk_kb_page_tags_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- kb_article_translations -> kb_page_translations.
ALTER TABLE "public"."kb_article_translations"
  DROP CONSTRAINT IF EXISTS "fk_kb_article_translations_org_article";
--> statement-breakpoint

UPDATE "public"."kb_article_translations" t
SET "article_id" = p."id"
FROM "public"."kb_pages" p
WHERE p."org_id" = t."org_id"
  AND p."source_article_id" = t."article_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_translations" RENAME COLUMN "article_id" TO "page_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_translations" RENAME TO "kb_page_translations";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_translations"
  RENAME CONSTRAINT "kb_article_translations_pkey" TO "kb_page_translations_pkey";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_translations"
  RENAME CONSTRAINT "uniq_kb_article_translations_org_id" TO "uniq_kb_page_translations_org_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_translations"
  RENAME CONSTRAINT "kb_article_translations_org_id_fkey" TO "kb_page_translations_org_id_fkey";
--> statement-breakpoint

ALTER INDEX "public"."uniq_kb_article_translations" RENAME TO "uniq_kb_page_translations";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_translations_org_article" RENAME TO "idx_kb_page_translations_org_page";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_translations"
  ADD CONSTRAINT "fk_kb_page_translations_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- kb_article_feedback -> kb_page_feedback.
ALTER TABLE "public"."kb_article_feedback"
  DROP CONSTRAINT IF EXISTS "fk_kb_article_feedback_org_article";
--> statement-breakpoint

UPDATE "public"."kb_article_feedback" f
SET "article_id" = p."id"
FROM "public"."kb_pages" p
WHERE p."org_id" = f."org_id"
  AND p."source_article_id" = f."article_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_feedback" RENAME COLUMN "article_id" TO "page_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_feedback" RENAME TO "kb_page_feedback";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_feedback"
  RENAME CONSTRAINT "kb_article_feedback_pkey" TO "kb_page_feedback_pkey";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_feedback"
  RENAME CONSTRAINT "uniq_kb_article_feedback_org_id" TO "uniq_kb_page_feedback_org_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_feedback"
  RENAME CONSTRAINT "kb_article_feedback_org_id_fkey" TO "kb_page_feedback_org_id_fkey";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_feedback_article" RENAME TO "idx_kb_page_feedback_page";
--> statement-breakpoint

ALTER INDEX "public"."uniq_kb_article_feedback_org_article_visitor" RENAME TO "uniq_kb_page_feedback_org_page_visitor";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_feedback"
  ADD CONSTRAINT "fk_kb_page_feedback_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- kb_article_restrictions -> kb_page_restrictions.
ALTER TABLE "public"."kb_article_restrictions"
  DROP CONSTRAINT IF EXISTS "fk_kb_article_restrictions_org_article";
--> statement-breakpoint

UPDATE "public"."kb_article_restrictions" r
SET "article_id" = p."id"
FROM "public"."kb_pages" p
WHERE p."org_id" = r."org_id"
  AND p."source_article_id" = r."article_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_restrictions" RENAME COLUMN "article_id" TO "page_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_restrictions" RENAME TO "kb_page_restrictions";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_restrictions"
  RENAME CONSTRAINT "kb_article_restrictions_pkey" TO "kb_page_restrictions_pkey";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_restrictions"
  RENAME CONSTRAINT "uniq_kb_article_restrictions_org_id" TO "uniq_kb_page_restrictions_org_id";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_restrictions"
  RENAME CONSTRAINT "kb_article_restrictions_org_id_fkey" TO "kb_page_restrictions_org_id_fkey";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_restrictions"
  RENAME CONSTRAINT "fk_kb_article_restrictions_org_membership" TO "fk_kb_page_restrictions_org_membership";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_restrictions_article" RENAME TO "idx_kb_page_restrictions_page";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_restrictions_org_article" RENAME TO "idx_kb_page_restrictions_org_page";
--> statement-breakpoint

ALTER INDEX "public"."idx_kb_article_restrictions_org_membership" RENAME TO "idx_kb_page_restrictions_org_membership";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_restrictions"
  ADD CONSTRAINT "fk_kb_page_restrictions_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- kb_article_chunks keeps its name and its article_id column; only its anchors
-- move. attachment_id widens to bigint because kb_page_attachments.id is a
-- bigint identity column, and an integer column cannot carry that foreign key.
ALTER TABLE "public"."kb_article_chunks"
  DROP CONSTRAINT IF EXISTS "fk_kb_chunks_org_attachment";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  DROP CONSTRAINT IF EXISTS "fk_kb_chunks_org_article";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  ALTER COLUMN "attachment_id" TYPE bigint;
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  ADD CONSTRAINT "fk_kb_chunks_org_attachment"
  FOREIGN KEY ("org_id", "attachment_id") REFERENCES "public"."kb_page_attachments" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint

-- The three article tables whose page-side equivalent already exists. The
-- preflight proved each is empty.
DROP TABLE IF EXISTS "public"."kb_article_versions";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_attachments";
--> statement-breakpoint

-- kb_article_comments has a self-referential FK (parent_id) which Postgres
-- resolves internally when the table itself is dropped.
DROP TABLE IF EXISTS "public"."kb_article_comments";
--> statement-breakpoint

-- Drop SET-NULL FK constraints on tables we keep, so they no longer block the
-- DROP TABLE below. The pointer columns themselves stay.
ALTER TABLE "public"."kb_events"
  DROP CONSTRAINT IF EXISTS "fk_kb_events_org_article";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  DROP CONSTRAINT IF EXISTS "fk_kb_pages_org_source_article";
--> statement-breakpoint

ALTER TABLE "public"."support_knowledge_gaps"
  DROP CONSTRAINT IF EXISTS "fk_support_knowledge_gaps_proposed_article_id_org";
--> statement-breakpoint

DROP TABLE "public"."kb_articles";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."kb_article_status";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."kb_article_visibility";
--> statement-breakpoint

-- A rename carries a table's OID, so its row-level security policy and its
-- grants travel with it. This asserts that rather than assuming it, and fails
-- the whole migration if any renamed table arrived without its tenant fence.
DO $$
DECLARE
  target        text;
  missing       text := '';
  survivor      text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'kb_page_tags', 'kb_page_translations', 'kb_page_feedback', 'kb_page_restrictions'
  ] LOOP
    IF to_regclass('public.' || target) IS NULL THEN
      missing := missing || format('%s is absent; ', target);
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = ('public.' || target)::regclass
        AND attname = 'page_id' AND NOT attisdropped
    ) THEN
      missing := missing || format('%s has no page_id column; ', target);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || target)::regclass
        AND contype = 'f'
        AND confrelid = 'public.kb_pages'::regclass
    ) THEN
      missing := missing || format('%s has no foreign key into kb_pages; ', target);
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || target)::regclass) THEN
      missing := missing || format('%s lost row-level security; ', target);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = target
    ) THEN
      missing := missing || format('%s has no policy; ', target);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = target
        AND grantee = 'streamline_app' AND privilege_type = 'SELECT'
    ) THEN
      missing := missing || format('%s is not readable by streamline_app; ', target);
    END IF;
  END LOOP;

  SELECT string_agg(name, ', ' ORDER BY name) INTO survivor
  FROM (VALUES
    ('kb_articles'), ('kb_article_tags'), ('kb_article_translations'),
    ('kb_article_feedback'), ('kb_article_restrictions'), ('kb_article_versions'),
    ('kb_article_comments'), ('kb_article_attachments')
  ) AS t(name)
  WHERE to_regclass('public.' || name) IS NOT NULL;

  IF survivor IS NOT NULL THEN
    missing := missing || format('%s survived the cutover; ', survivor);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '1174 postcondition failed: %', missing;
  END IF;
END $$;
