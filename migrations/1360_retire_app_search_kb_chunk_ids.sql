-- 1360: Drop app.search_kb_chunk_ids — no production caller.
--
-- This SECURITY DEFINER function was introduced in migration 0703 to work
-- around the RLS security barrier that prevented the HNSW index from being
-- used for ANN searches on kb_article_chunks under a minority tenant.
-- Migrations 0714 and 0717 iterated on the implementation; migration 1000
-- rewrote the body to a bare SELECT without a MATERIALIZED CTE.
--
-- The service layer (kb-vector-candidate-query.ts) now issues direct SQL:
--   SET LOCAL hnsw.iterative_scan = relaxed_order
--   SET LOCAL hnsw.ef_search = N
-- before the vector ORDER BY query.  That is the correct approach and makes
-- this function redundant.
--
-- STATIC EVIDENCE OF NON-USE
-- grep -r "search_kb_chunk_ids" backend/src/ --include="*.ts"
-- returns exactly one hit: kb-vector-minority-tenant.spec.ts:51, which is a
-- mock that branches on the function name to simulate historic behaviour the
-- service no longer exhibits.  No production TypeScript path reaches the
-- function.
--
-- RUNTIME CALL-COUNT VERIFICATION IS NOT POSSIBLE
-- track_functions is set to 'pl', which records only procedural-language
-- (PL/pgSQL) functions.  app.search_kb_chunk_ids is LANGUAGE sql.  None of
-- the 40 sql-language functions in app/public have a pg_stat_user_functions
-- row; the call count reads zero whether or not the function is invoked.
-- A call-count guard would be structurally incapable of firing and would
-- mislead a future reader into believing the drop was verified at runtime.
--
-- NOTE ON EXTERNAL CALLERS
-- Static analysis covers only this repository.  The function carries
-- prosecdef = true: it was deliberately built to be callable by a
-- lower-privileged role.  That is exactly the shape a dashboard query, an
-- analytics tool or a saved psql snippet would use.  Confirm no external
-- caller exists before applying this migration.
--
-- PRECONDITION
-- The DO block below asserts the function exists with the exact signature
-- from migration 1000.  It raises loudly if the function is already absent
-- or if the signature has drifted, so the migration never silently no-ops
-- through IF EXISTS.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND p.proname = 'search_kb_chunk_ids';

  IF NOT FOUND THEN
    RAISE EXCEPTION '1360 precondition: app.search_kb_chunk_ids not found — has it already been dropped?';
  END IF;

  IF v_args <> 'p_vec vector, p_limit integer' THEN
    RAISE EXCEPTION '1360 precondition: app.search_kb_chunk_ids found with signature "%" — expected "p_vec vector, p_limit integer"; signature has drifted', v_args;
  END IF;
END $$;
--> statement-breakpoint

DROP FUNCTION app.search_kb_chunk_ids(vector, integer);
