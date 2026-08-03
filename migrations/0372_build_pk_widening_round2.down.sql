-- Rollback for 0372 — narrow the Build tier-2 PKs and their FK columns back to int4.
--
-- REFUSES to narrow when any surviving value would overflow int4 (2,147,483,647).
-- Narrowing past that point is silent data corruption, so this fails loudly instead.
-- Same guarantee as 0370's rollback.
--
-- FK columns are narrowed BEFORE their referenced PKs so no intermediate state has a
-- wide FK pointing at a narrow key.

SET statement_timeout = 0;

--> statement-breakpoint
DO $$
DECLARE
  r record;
  max_val bigint;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ticket_comments',           'parent_comment_id'),
      ('ticket_comment_mentions',   'comment_id'),
      ('ticket_comment_reactions',  'comment_id'),
      ('ticket_assignees',          'id'),
      ('ticket_label_mappings',     'id'),
      ('ticket_watchers',           'id'),
      ('ticket_comments',           'id')
    ) AS v(tbl, col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = r.tbl) THEN
      CONTINUE;
    END IF;

    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I', r.col, r.tbl) INTO max_val;

    IF max_val > 2147483647 THEN
      RAISE EXCEPTION 'refusing to narrow %.% - max value % exceeds int4', r.tbl, r.col, max_val;
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DATA TYPE integer', r.tbl, r.col);
  END LOOP;
END $$;

--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_assignees','ticket_label_mappings','ticket_watchers','ticket_comments'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t || '_id_seq' AND relkind = 'S') THEN
      EXECUTE format('ALTER SEQUENCE %I AS integer', t || '_id_seq');
    END IF;
  END LOOP;
END $$;
