-- 1011: make mail metadata list paging keyset-stable and give mail search an
-- index a leading wildcard can actually use.
--
-- Two problems, one table.
--
-- 1. ORDERING. idx_mail_metadata_list is (org_id, user_membership_id, folder,
--    date DESC). MailMetadataService.listCached ordered by date alone, so rows
--    sharing a timestamp had no defined order between them and a keyset page
--    boundary could repeat or skip one. idx_mail_metadata_list_keyset adds
--    id DESC as the tiebreak so (date, id) is a total order.
--
--    Measured on a 258k-row four-tenant scratch copy as the non-owner role with
--    the tenant GUC set, VACUUM ANALYZEd, keyset page 2 (LIMIT 50), buffers:
--
--      tenant       with keyset index   without it
--      majority                    60   102  (Incremental Sort over the prefix index)
--      tiny                        60   102
--
--    idx_mail_metadata_list is then a strict prefix of the new index, and it is
--    DROPPED rather than kept beside it. That is not the prefix-containment
--    argument 1007 corrected -- containment alone proves reachability, not cost,
--    so it was measured. Page one (ORDER BY date DESC LIMIT 50, the shape
--    read-cost-budgets.mjs "mail-inbox-cached" measures) with the prefix index
--    dropped:
--
--      tenant       both indexes   keyset only
--      majority               92   95  (Index Scan, no Seq Scan -- the budget's
--      tiny                   89   92   forbid-seq-scan assertion still holds)
--
--    Three buffers, against 49 MB of index on an 89 MB table and one B-tree
--    maintained on every row of an upsert-heavy mirror that is rewritten on
--    every inbox load. Keeping both would be paying a write tax for 3 reads.
--
-- 2. SEARCH. listCached's search branch is three leading-wildcard ILIKEs on
--    subject / sender_email / sender_name, which backend/CLAUDE.md section 3
--    bans outright and which no index on this table could serve.
--
--    Measured the same way, selective term, LIMIT 50, buffers:
--
--      term         matches   leading-wildcard ILIKE      definer + trigram
--      Zephyrine         27   13,595 / 13,814-13,820      693-697
--      Invoice           15   13,595 / 13,814-13,817      573-575
--      update          >cap   13,595 (majority) / 92      falls back to ILIKE
--
--    (majority tenant first, the three minority tenants second -- their plans
--    genuinely differ: the majority tenant takes a BitmapAnd on
--    idx_mail_metadata_search, the minorities walk idx_mail_metadata_list_keyset.
--    "update" is the >cap regime and is deliberately unchanged, which is why the
--    92-buffer minority reading must not be "improved".)
--
--    A GIN trigram index alone does not fix it, because mail_message_metadata
--    has RLS enabled (policy tenant_isolation: org_id = app.current_org_id()).
--    texticlike is proleakproof = false, so the planner must evaluate the
--    security qual before the search qual and refuses the index -- the same
--    failure documented for tickets in 0424/0425 and kb_articles in 0453, and
--    ALTER FUNCTION ... LEAKPROOF is impossible on Neon.
--
--    So the search runs inside a SECURITY DEFINER function owned by the
--    BYPASSRLS owner, with the five properties 0453 established:
--      * org comes from app.current_org_id() and is never a parameter, so it
--        fails closed with 42501 when the GUC is absent;
--      * it returns message ids only, never row data;
--      * the caller's own query still runs under RLS with its own membership,
--        folder and account predicates -- safety does not move into this
--        function, it only stops the index being skipped;
--      * EXECUTE is revoked from PUBLIC and granted to the app role;
--      * it takes a limit and the caller asks for cap+1, falling back to the
--        plain ILIKE when the cap is hit (a term matching most of the table is
--        FASTER as a seq scan under LIMIT than as a materialised id list).
--
--    p_membership_id and p_folder are narrowing parameters, not the tenant
--    selector. They exist so the trigram bitmap is ANDed down before the heap
--    fetch; the caller re-applies both outside the function, so passing another
--    member's id yields ids the outer query then discards.
--
-- The indexed expression concatenates the three searchable columns with chr(1)
-- as a separator. chr(1) cannot appear in an HTTP query string that reached the
-- Zod boundary, so a search term can never span a separator and the single
-- expression match is exactly equivalent to the OR of three column ILIKEs --
-- one GIN index instead of three on an upsert-heavy cache table. The function
-- asserts strpos(p_q, chr(1)) = 0 so the equivalence holds unconditionally.
--
-- CREATE INDEX rather than CONCURRENTLY: drizzle-kit migrate wraps the file in a
-- transaction (discipline rule 7). lock_timeout bounds the wait.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_mail_metadata_list_keyset"
  ON "mail_message_metadata" ("org_id", "user_membership_id", "folder", "date" DESC, "id" DESC);
--> statement-breakpoint

DROP INDEX IF EXISTS public."idx_mail_metadata_list";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_mail_metadata_search_trgm"
  ON "mail_message_metadata"
  USING gin ((
    coalesce("subject", '') || chr(1) ||
    coalesce("sender_name", '') || chr(1) ||
    coalesce("sender_email", '')
  ) gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_mail_message_ids(
  p_q text,
  p_membership_id integer,
  p_folder text,
  p_limit integer
)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT m.id
  FROM public.mail_message_metadata m
  WHERE m.org_id = app.current_org_id()
    AND m.user_membership_id = p_membership_id
    AND m.folder = p_folder
    AND strpos(p_q, chr(1)) = 0
    AND (
      coalesce(m.subject, '') || chr(1) ||
      coalesce(m.sender_name, '') || chr(1) ||
      coalesce(m.sender_email, '')
    ) ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_mail_message_ids(text, integer, text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_mail_message_ids(text, integer, text, integer) TO streamline_app;
