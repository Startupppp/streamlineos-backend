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
--   * NOT rewritten, and REPORTED SEPARATELY: a whole URL sitting in a column
--     that participates in a primary key, unique constraint or foreign key, or
--     that is generated or an identity. Those cannot be assigned here — two
--     spellings of one URL ("%20" and a space) would collapse onto the same key
--     and the unique violation would abort the whole deploy. They are counted as
--     CONSTRAINT-HELD, never as EMBEDDED: the remediation is completely
--     different (the script rewrites them; an <img src> needs a human decision
--     about the render), and calling one the other sends the operator looking
--     for rich text that is not there. This is not hypothetical —
--     termination_supporting_documents.legacy_url is text NOT NULL under
--     unique(organization_id, termination_id, legacy_url) in the head schema.
--
-- A base configured WITH a trailing slash minted "<base>//<key>", because the
-- deleted publicUrlFor concatenated "${publicBase}/${key}" and env.validation.ts
-- accepts a trailing slash. Leading slashes are stripped from the extracted key:
-- leaving them would point the row at an object that does not exist, which the
-- deliberately-no-op down file cannot reverse.
--
-- Discovery is catalog-driven — every text/varchar/bpchar column of every
-- ordinary table in every application schema — so a column added after this was
-- written is still swept.
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
-- ⚠ THAT ABORT IS REACHABLE ON THIS SCHEMA, AND IT FAILS THE DEPLOY. Measured
-- on a scratch database: 981 tables at head have RLS enabled and exactly ONE —
-- public.external_effect_ledger, set by migrations/0474_external_effect_ledger
-- .sql:27 — also has FORCE ROW LEVEL SECURITY. FORCE means even the table's
-- OWNER is filtered, so row_security_active() is true for a migration role that
-- merely owns the database. Reproduced as a NOSUPERUSER NOBYPASSRLS owner: the
-- exception fires, the transaction rolls back, and 1047 rewrites nothing.
-- Only a superuser or a BYPASSRLS role gets through. RUN THIS AS THE MIGRATION
-- ROLE BEFORE DEPLOYING to find out which way it will go — an empty result
-- means 1047 will proceed:
--   SELECT n.nspname, c.relname
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE c.relkind = 'r' AND c.relrowsecurity AND row_security_active(c.oid);
-- The abort is deliberately NOT downgraded to a warning: a warning would put
-- "nothing to do" and "could not see it" back on the same line, which is the
-- failure this whole ticket exists to prevent. And FORCE is deliberately NOT
-- toggled off around the scan: a migration that turns off a security control
-- and depends on its own rollback to turn it back on is a worse defect than
-- the one it fixes.
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

  -- A base configured WITH a trailing slash minted "<base>//<key>", because the
  -- deleted publicUrlFor concatenated "${publicBase}/${key}" without stripping
  -- one. Nothing rejects that: env.validation.ts accepts a trailing slash. The
  -- leading slashes are part of the URL, never part of the object key, and
  -- leaving them turns the rewrite into a pointer at an object that does not
  -- exist — a worse outcome than the leak, and one the no-op down file cannot
  -- reverse.
  tail := regexp_replace(tail, '^/+', '');

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
  blocked_expr     text;
  found_before     bigint;
  found_after      bigint;
  blocked_after    bigint;
  embedded_after   bigint;
  rewritten        bigint;
  total_before     bigint := 0;
  total_rewritten  bigint := 0;
  total_embedded   bigint := 0;
  total_blocked    bigint := 0;
  tables_scanned   int := 0;
  rls_blocked      text[] := ARRAY[]::text[];
  constraint_held  text[] := ARRAY[]::text[];
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
           ) AS where_sql,
           -- The MIRROR of where_sql: a column whose whole value can BE a public
           -- URL but which this migration may not assign — it participates in a
           -- primary key, unique constraint or foreign key, or it is generated or
           -- an identity. Skipping it is correct (rewriting two spellings of one
           -- URL to the same key would collide and abort the deploy), but before
           -- this aggregate existed such a row was counted and announced as
           -- EMBEDDED, which told the operator to go looking for an <img src>
           -- inside rich text. It is not embedded; it is a bare, whole, leaked
           -- URL that needs a hand or the script. termination_supporting_documents
           -- .legacy_url is a live column of exactly this shape: text NOT NULL,
           -- under unique(org_id, termination_id, legacy_url).
           string_agg(
             DISTINCT format('%I ~ %L', a.attname, whole_pat),
             ' OR '
           ) FILTER (
             WHERE ty.typname IN ('text','varchar','bpchar')
               AND (
                 a.attgenerated <> ''
                 OR a.attidentity <> ''
                 OR EXISTS (
                   SELECT 1 FROM pg_constraint k
                   WHERE k.conrelid = c.oid
                     AND k.contype IN ('p','u','f')
                     AND a.attnum = ANY(k.conkey)
                 )
               )
           ) AS blocked_sql
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

    blocked_expr := tbl.blocked_sql;
    blocked_after := 0;
    IF blocked_expr IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %s', tbl.s, tbl.t, blocked_expr)
        INTO blocked_after;
    END IF;

    -- A row can hold both, so the two classes are counted so they never overlap:
    -- CONSTRAINT-HELD wins, and EMBEDDED is what is left over.
    IF blocked_expr IS NULL THEN
      embedded_after := found_after;
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM %I.%I WHERE (%s) AND NOT COALESCE(%s, false)',
        tbl.s, tbl.t, contains_expr, blocked_expr
      ) INTO embedded_after;
    END IF;

    total_embedded := total_embedded + embedded_after;
    total_blocked := total_blocked + blocked_after;
    IF blocked_after > 0 THEN
      constraint_held := constraint_held || format('%I.%I (%s row(s))', tbl.s, tbl.t, blocked_after);
    END IF;

    RAISE NOTICE '1047 % .% : held=% rewritten=% CONSTRAINT-HELD=% EMBEDDED-REMAINING=%',
      tbl.s, tbl.t, found_before, rewritten, blocked_after, embedded_after;
  END LOOP;

  IF array_length(rls_blocked, 1) > 0 THEN
    RAISE EXCEPTION
      '1047 aborted: % table(s) are read through a row-level security policy this role does not bypass, so a rewrite of 0 would be indistinguishable from a clean table: %. Re-run as a role that BYPASSES row-level security (superuser, or a role with the BYPASSRLS attribute). BEING THE TABLE OWNER IS NOT ENOUGH when the table carries FORCE ROW LEVEL SECURITY — public.external_effect_ledger does, set by migrations/0474_external_effect_ledger.sql, and it is the one table at head that does. Before deploying, run this as the migration role to see which way it will go: SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = ''r'' AND c.relrowsecurity AND row_security_active(c.oid);',
      array_length(rls_blocked, 1), array_to_string(rls_blocked, ', ');
  END IF;

  RAISE NOTICE '1047 SUMMARY tables_scanned=% rows_holding_a_public_url=% rows_rewritten=% rows_CONSTRAINT_HELD=% rows_with_an_EMBEDDED_public_url_remaining=%',
    tables_scanned, total_before, total_rewritten, total_blocked, total_embedded;

  IF total_blocked > 0 THEN
    RAISE WARNING '1047: % row(s) hold a WHOLE public object URL in a column this migration may not assign (it participates in a primary key, unique constraint or foreign key, or is generated/identity): %. These are NOT embedded in rich text and need no rendering decision — rewrite them with scripts/backfill-public-object-urls.mjs --apply, which does assign such columns, and be ready for a unique violation if two spellings of one URL collapse onto the same key.',
      total_blocked, array_to_string(constraint_held, ', ');
  END IF;

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
