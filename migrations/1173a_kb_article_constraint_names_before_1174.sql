-- 1173a — give a cold build the constraint names 1174 renames, before 1174 runs.
--
-- 1174_kb_articles_cutover_contract renames the kb_article_* tables to kb_page_* and, with them,
-- five constraints by the names the production catalog carries. A cold build creates the same
-- constraints under the names drizzle generated instead, so a strict replay (migration:proof)
-- died at
--   1174 stmt 2/2: 42704 constraint "kb_article_tags_org_id_article_id_tag_id_pk" for table
--   "kb_page_tags" does not exist
-- and db:bootstrap could never apply 1174 or 1226 at all (the cold ceiling was 1044/1046).
--
--   cold name                                             production name (what 1174 expects)
--   kb_article_tags_pkey                                  kb_article_tags_org_id_article_id_tag_id_pk
--   kb_article_tags_org_id_fk                             kb_article_tags_org_id_fkey
--   kb_article_translations_org_id_organizations_id_fk    kb_article_translations_org_id_fkey
--   kb_article_feedback_org_id_organizations_id_fk        kb_article_feedback_org_id_fkey
--   kb_article_restrictions_org_id_organizations_id_fk    kb_article_restrictions_org_id_fkey
--
-- Each pair was checked on a cold database: identical definitions (the PK is
-- (org_id, article_id, tag_id); each FK is org_id -> organizations(id) ON DELETE CASCADE).
-- Only the name differs, so a rename is the whole repair.
--
-- Every rename is guarded: it runs only when the table exists, the cold name exists and the
-- production name does not. On production, and on any database where 1174 already ran, every
-- statement is a no-op.
--
-- It also drops the superseded (org_id, article_id) / (org_id, attachment_id) foreign keys that
-- then stopped 1174 with
--   2BP01 cannot drop table kb_article_attachments / kb_articles because other objects depend on it
-- 0971_ar02_drop_superseded_tenant_fks_2 and 0972_..._3 drop every one of them as superseded by
-- the fk_*_org_article / fk_kb_chunks_org_attachment pairs. But 0577_tenant_fks_public_b, which
-- adds them, is journalled at array position 840, after 0971 (615). Production ran 0577 first,
-- so it has none of them. A cold replay re-adds them after 0971 has run. The list below is
-- exactly those 0971/0972 statements for the tables 1174 touches, so on production every one
-- is a no-op.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('kb_article_tags',         'kb_article_tags_pkey',                               'kb_article_tags_org_id_article_id_tag_id_pk'),
      ('kb_article_tags',         'kb_article_tags_org_id_fk',                          'kb_article_tags_org_id_fkey'),
      ('kb_article_translations', 'kb_article_translations_org_id_organizations_id_fk', 'kb_article_translations_org_id_fkey'),
      ('kb_article_feedback',     'kb_article_feedback_org_id_organizations_id_fk',     'kb_article_feedback_org_id_fkey'),
      ('kb_article_restrictions', 'kb_article_restrictions_org_id_organizations_id_fk', 'kb_article_restrictions_org_id_fkey')
    ) AS v(tbl, cold_name, prod_name)
  LOOP
    IF to_regclass('public.' || rec.tbl) IS NULL THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || rec.tbl)::regclass AND conname = rec.cold_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || rec.tbl)::regclass AND conname = rec.prod_name
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', rec.tbl, rec.cold_name, rec.prod_name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('kb_article_attachments',  'fk_kb_article_attachments_article_id_org'),
      ('kb_article_chunks',       'fk_kb_article_chunks_article_id_org'),
      ('kb_article_chunks',       'fk_kb_article_chunks_attachment_id_org'),
      ('kb_article_feedback',     'fk_kb_article_feedback_article_id_org'),
      ('kb_article_restrictions', 'fk_kb_article_restrictions_article_id_org'),
      ('kb_article_tags',         'fk_kb_article_tags_article_id_org'),
      ('kb_article_translations', 'fk_kb_article_translations_article_id_org'),
      ('kb_article_versions',     'fk_kb_article_versions_article_id_org'),
      ('kb_events',               'fk_kb_events_article_id_org')
    ) AS v(tbl, con)
  LOOP
    IF to_regclass('public.' || rec.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', rec.tbl, rec.con);
    END IF;
  END LOOP;
END $$;
