-- 1047: rewrite every stored PERMANENT PUBLIC object-storage URL back to the
-- opaque, tenant-private object key it points at.
--
-- Ticket 33 removed the minting: StorageService used to return
-- "<public base>/<key>" for any folder not on a hard-coded private list, and
-- call sites persisted that value (kb_sources.file_url,
-- feedbucket_attachments.file_url, feedbucket_submissions.screenshot_url /
-- .recording_url, payslip_publications.pdf_url, chat_attachments.file_url).
-- Deleting the minting stops NEW rows; it does nothing about rows already
-- written. This is the other half.
--
-- WHY A MIGRATION AND NOT ONLY THE SCRIPT.
-- scripts/backfill-public-object-urls.mjs does this as an operator action, and
-- an operator action that has to be remembered is an operator action that gets
-- skipped: the ticket has carried "run the backfill against the real database"
-- as an OWED, never-performed step. A journalled migration runs once, at
-- deploy, as the migration role, and records that it ran. It rewrites 0 rows on
-- a clean database, so it costs nothing where there is nothing to fix.
--
-- WHAT IT MATCHES, AND WHAT IT DELIBERATELY DOES NOT.
--   * Matched: a value that IS, in its entirety, an R2 public development URL —
--     https://pub-<32 hex>.r2.dev/<key> — optionally carrying a ?query or
--     #fragment. That host shape is R2's public bucket address and is what
--     NEXT_PUBLIC_R2_PUBLIC_URL holds. Percent-escapes in the key are decoded,
--     so "%20" becomes a space and the value comes out equal to the real key.
--   * NOT matched, on purpose: any other URL. A customer website, a webhook
--     target, an external job posting, an avatar hosted elsewhere — none of
--     them have that host shape and none of them are touched.
--   * NOT matched, and this is a REAL GAP, stated rather than hidden: a public
--     base served from a CUSTOM DOMAIN rather than the r2.dev development URL.
--     SQL cannot read NEXT_PUBLIC_R2_PUBLIC_URL, so the pattern has to be
--     self-describing. Where a custom domain was ever configured,
--     scripts/backfill-public-object-urls.mjs --base <url> remains the
--     instrument, and this migration is not sufficient on its own.
--   * NOT rewritten, on purpose: an occurrence EMBEDDED inside a larger value —
--     an <img src> in a rich-text body, a URL inside a jsonb blob, a member of
--     a text[]. Rewriting an <img src> to a bare object key would break the
--     rendering rather than fix the leak, and which JSON path is an object
--     address is not knowable from the catalog. Those rows are COUNTED and
--     announced (RAISE NOTICE "EMBEDDED …"), so the residue is a number on the
--     deploy log instead of an invisible remainder.
--
-- Discovery is catalog-driven — every text/varchar/bpchar column of every
-- ordinary table in every application schema — so a column added after this was
-- written is still swept. Columns that participate in a primary key, unique
-- constraint or foreign key are skipped: rewriting an identifying value would
-- break the reference, and no such column has ever held an object URL.
-- Generated and identity columns are skipped because they cannot be assigned.
--
-- Idempotent: after it runs, no value matches the pattern any more, so a second
-- run rewrites 0. Safe to re-run.
--
-- ROW-LEVEL SECURITY: if the migration role reads any table through a policy it
-- does not bypass, that table's rows are invisible and a rewrite of 0 would be
-- indistinguishable from a clean table. This aborts with an exception naming
-- those tables rather than reporting a clean pass over rows it never saw. That
-- distinction is the single most misread thing on this ticket.
--
-- THIS MIGRATION DOES NOT MAKE THE OBJECTS UNREACHABLE. Rewriting the database
-- stops the application handing out a permanent URL; every object already at a
-- public address stays fetchable to anyone who copied one until public access
-- is removed from the buckets named by R2_BUCKET_NAME and R2_KB_BUCKET_NAME in
-- the Cloudflare console. That is an operator action with no code equivalent
-- and this migration is not a substitute for it.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.__t33_url_decode(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $fn$
  SELECT COALESCE(
    convert_from(
      CAST(
        E'\\x' || string_agg(
          CASE
            WHEN length(t.m[1]) = 3 AND left(t.m[1], 1) = '%' THEN substring(t.m[1] from 2)
            ELSE encode(convert_to(t.m[1], 'UTF8'), 'hex')
          END,
          ''
        ) AS bytea
      ),
      'UTF8'
    ),
    input
  )
  FROM regexp_matches(input, '%[0-9a-fA-F]{2}|.', 'g') AS t(m);
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.__t33_object_key(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  tail text;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF value !~ '^https?://pub-[0-9a-f]{32}\.r2\.dev/[^[:space:]<>"'']+$' THEN RETURN value; END IF;

  tail := regexp_replace(value, '^https?://pub-[0-9a-f]{32}\.r2\.dev/', '');
  tail := split_part(split_part(tail, '?', 1), '#', 1);
  IF tail = '' THEN RETURN value; END IF;

  IF position('%' in tail) > 0 THEN
    BEGIN
      tail := public.__t33_url_decode(tail);
    EXCEPTION WHEN OTHERS THEN
      RETURN value;
    END;
  END IF;

  RETURN tail;
END;
$fn$;
--> statement-breakpoint

DO $$
DECLARE
  contains_pat CONSTANT text := 'https?://pub-[0-9a-f]{32}\.r2\.dev/';
  whole_pat    CONSTANT text := '^https?://pub-[0-9a-f]{32}\.r2\.dev/[^[:space:]<>"'']+$';
  tbl              record;
  contains_expr    text;
  where_expr       text;
  set_expr         text;
  found_before     bigint;
  found_after      bigint;
  rewritten        bigint;
  total_before     bigint := 0;
  total_rewritten  bigint := 0;
  total_embedded   bigint := 0;
  tables_scanned   int := 0;
  rls_blocked      text[] := ARRAY[]::text[];
BEGIN
  FOR tbl IN
    SELECT n.nspname AS s,
           c.relname AS t,
           c.relrowsecurity AND row_security_active(c.oid) AS rls_filtered,
           string_agg(
             DISTINCT format('COALESCE(%I::text, %L) ~ %L', a.attname, '', contains_pat),
             ' OR '
           ) FILTER (
             WHERE ty.typname IN ('text','varchar','bpchar','json','jsonb','xml','_text','_varchar')
           ) AS contains_sql,
           string_agg(
             DISTINCT format('%I = public.__t33_object_key(%I)', a.attname, a.attname),
             ', '
           ) FILTER (
             WHERE ty.typname IN ('text','varchar','bpchar')
               AND a.attgenerated = ''
               AND a.attidentity = ''
               AND NOT EXISTS (
                 SELECT 1 FROM pg_constraint k
                 WHERE k.conrelid = c.oid
                   AND k.contype IN ('p','u','f')
                   AND a.attnum = ANY(k.conkey)
               )
           ) AS set_sql,
           string_agg(
             DISTINCT format('%I ~ %L', a.attname, whole_pat),
             ' OR '
           ) FILTER (
             WHERE ty.typname IN ('text','varchar','bpchar')
               AND a.attgenerated = ''
               AND a.attidentity = ''
               AND NOT EXISTS (
                 SELECT 1 FROM pg_constraint k
                 WHERE k.conrelid = c.oid
                   AND k.contype IN ('p','u','f')
                   AND a.attnum = ANY(k.conkey)
               )
           ) AS where_sql
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE c.relkind = 'r'
      AND n.nspname NOT LIKE 'pg\_%'
      AND n.nspname <> 'information_schema'
      AND c.relname <> '__drizzle_migrations'
    GROUP BY n.nspname, c.relname, c.oid, c.relrowsecurity
    ORDER BY n.nspname, c.relname
  LOOP
    contains_expr := tbl.contains_sql;
    IF contains_expr IS NULL THEN CONTINUE; END IF;

    IF tbl.rls_filtered THEN
      rls_blocked := rls_blocked || format('%I.%I', tbl.s, tbl.t);
      CONTINUE;
    END IF;

    tables_scanned := tables_scanned + 1;

    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %s', tbl.s, tbl.t, contains_expr)
      INTO found_before;
    IF found_before = 0 THEN CONTINUE; END IF;

    total_before := total_before + found_before;
    rewritten := 0;

    set_expr := tbl.set_sql;
    where_expr := tbl.where_sql;
    IF set_expr IS NOT NULL AND where_expr IS NOT NULL THEN
      EXECUTE format('UPDATE %I.%I SET %s WHERE %s', tbl.s, tbl.t, set_expr, where_expr);
      GET DIAGNOSTICS rewritten = ROW_COUNT;
      total_rewritten := total_rewritten + rewritten;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %s', tbl.s, tbl.t, contains_expr)
      INTO found_after;
    total_embedded := total_embedded + found_after;

    RAISE NOTICE '1047 % .% : held=% rewritten=% EMBEDDED-REMAINING=%',
      tbl.s, tbl.t, found_before, rewritten, found_after;
  END LOOP;

  IF array_length(rls_blocked, 1) > 0 THEN
    RAISE EXCEPTION
      '1047 aborted: % table(s) are read through a row-level security policy this role does not bypass, so a rewrite of 0 would be indistinguishable from a clean table: %. Re-run as the database owner.',
      array_length(rls_blocked, 1), array_to_string(rls_blocked, ', ');
  END IF;

  RAISE NOTICE '1047 SUMMARY tables_scanned=% rows_holding_a_public_url=% rows_rewritten=% rows_with_an_EMBEDDED_public_url_remaining=%',
    tables_scanned, total_before, total_rewritten, total_embedded;

  IF total_embedded > 0 THEN
    RAISE WARNING '1047: % row(s) still carry a public object URL EMBEDDED inside a larger value (rich text, jsonb or an array). Those are NOT rewritten here — see the header — and remain a leak until the buckets are made private.',
      total_embedded;
  END IF;
END
$$;
--> statement-breakpoint

DROP FUNCTION IF EXISTS public.__t33_object_key(text);
--> statement-breakpoint

DROP FUNCTION IF EXISTS public.__t33_url_decode(text);
