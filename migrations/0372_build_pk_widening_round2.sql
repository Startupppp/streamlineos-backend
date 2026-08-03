-- 0372 — Build: widen the second tier of high-velocity PKs from int4 to int8
--
-- `serial` is int4 (max 2,147,483,647). 0370 widened the four append-only tables that
-- exhaust it first (ticket_activity_log, webhook_deliveries, ticket_comment_mentions,
-- project_daily_snapshots). This migration covers the next tier: the ticket collaboration
-- table and the three ticket junction tables, which grow at 1-5 rows per ticket.
--
-- Exhaustion is a hard INSERT failure, not a slowdown, and the repair on a table holding
-- hundreds of millions of rows is an exclusive lock for the duration of a full rewrite.
-- Doing it while the tables are small is the entire point.
--
-- ticket_comments is referenced by three int4 FK columns. They are widened in the same
-- migration: leaving a narrow FK against a wide PK is both a correctness hazard and
-- defeats index usage on the join.
--
--   ticket_comments.id            <- ticket_comments.parent_comment_id      (self)
--                                 <- ticket_comment_mentions.comment_id
--                                 <- ticket_comment_reactions.comment_id
--
-- DELIBERATELY EXCLUDED: tickets.id. It is referenced by 27 tables (verified against
-- information_schema, not assumed). Widening it is a separate, much larger operation that
-- must widen every referencing column in the same transaction. At ~100-200M rows/year it
-- has 10-20 years of int4 headroom, so it is not urgent. Recorded here so the omission
-- reads as a decision rather than an oversight.
--
-- LOCKING: ALTER COLUMN ... SET DATA TYPE takes an ACCESS EXCLUSIVE lock and rewrites the
-- table. On the current data volume this is effectively instant. On a large production
-- table it is not — schedule a window.
--
-- Idempotent: every change is guarded on the column's current type, so re-running is a
-- no-op and never re-rewrites a table.

SET statement_timeout = 0;

--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_assignees','ticket_label_mappings','ticket_watchers','ticket_comments'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid
      JOIN pg_type ty ON ty.oid = a.atttypid
      WHERE c.relname = t AND a.attname = 'id' AND ty.typname = 'int4'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DATA TYPE bigint', t);
      RAISE NOTICE 'widened %.id to bigint', t;
    ELSE
      RAISE NOTICE 'skipped %.id (already bigint)', t;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t || '_id_seq' AND relkind = 'S') THEN
      EXECUTE format('ALTER SEQUENCE %I AS bigint', t || '_id_seq');
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ticket_comments',           'parent_comment_id'),
      ('ticket_comment_mentions',   'comment_id'),
      ('ticket_comment_reactions',  'comment_id')
    ) AS v(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid
      JOIN pg_type ty ON ty.oid = a.atttypid
      WHERE c.relname = r.tbl AND a.attname = r.col AND ty.typname = 'int4'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DATA TYPE bigint', r.tbl, r.col);
      RAISE NOTICE 'widened %.% to bigint', r.tbl, r.col;
    ELSE
      RAISE NOTICE 'skipped %.% (already bigint or absent)', r.tbl, r.col;
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ')
    INTO bad
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid
  JOIN pg_type ty ON ty.oid = a.atttypid
  WHERE ty.typname = 'int4'
    AND (
      (c.relname IN ('ticket_assignees','ticket_label_mappings','ticket_watchers','ticket_comments') AND a.attname = 'id')
      OR (c.relname = 'ticket_comments'          AND a.attname = 'parent_comment_id')
      OR (c.relname = 'ticket_comment_mentions'  AND a.attname = 'comment_id')
      OR (c.relname = 'ticket_comment_reactions' AND a.attname = 'comment_id')
    );

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0372 incomplete - still int4: %', bad;
  END IF;
END $$;
