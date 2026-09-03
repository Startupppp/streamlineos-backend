-- 1059 — reshape the ticket-board rank index so it actually carries the board's ORDER BY.
--
-- THE DEFECT
--
-- The board page is the `orderBy === "rank"` branch of
-- src/modules/build/core/projects-tickets-read.service.ts, and it sorts
--
--     ORDER BY rank ASC, id ASC
--
-- deliberately: `listTicketsByCursor`'s own comment says the board "pages by keyset on
-- (rank, id) — the order it already renders in, and a total order because id is unique",
-- and board-keyset.spec.ts pins that two-key sort together with the two-key cursor.
--
-- The index it was supposed to use does not carry that order. 0575 built one index per
-- sortable column from a single template — (org_id, project_id, <sort col>, created_at DESC,
-- id) — because every OTHER orderBy branch really does sort [col, created_at DESC, id].
-- The rank branch does not, so idx_tickets_org_project_rank_sort was born with
-- `created_at DESC` sitting between `rank` and `id`, matching nothing.
--
-- build.tickets.rank is numeric NOT NULL DEFAULT 1000 and only `rankTicket` (drag to
-- reorder) and `rebalanceProjectRanks` ever change it, so a project nobody has reordered is
-- ONE rank group — and then "presorted by rank" presorts nothing.
--
-- MEASURED — scratch_perf_seed, project 21, 1,850 live tickets, as streamline_app with
-- app.organization_id set (the owner has BYPASSRLS and its plans hide the RLS qual),
-- ANALYZEd, EXPLAIN (ANALYZE, BUFFERS). LIMIT 101 = the API's limit+1 probe.
--
--   page 1, before          Incremental Sort  Presorted Key: rank  Full-sort Groups: 1
--                           Index Only Scan idx_tickets_org_project_rank_sort rows=1850
--                           Buffers: shared hit=16 read=33
--   page 1, after           Index Only Scan idx_tickets_org_project_rank_id rows=101
--                           no sort node      Buffers: shared hit=15 read=4
--
--   page N, before          (rank, id) > (1000, 19001) is a Filter, not an Index Cond
--                           Rows Removed by Filter: 501, index rows=1349 -> 1850 read
--                           Buffers: shared hit=16 read=32
--   page N, after           same Filter, but the scan is in (rank, id) order and stops at
--                           the LIMIT: rows=101, Rows Removed by Filter: 501 -> 602 read
--                           Buffers: shared hit=5 read=5
--
-- 1,850 index rows to render 101 is 18.3x. useProjectBoardTickets auto-loads five pages of
-- 100 on open (frontend hooks/api/build/ticket-queries.ts, BOARD_AUTOLOAD_LIMIT = 500), so a
-- 20,000-ticket project read ~100,000 index rows per board open, per user. The row cost never
-- showed up in a buffer ceiling — sorting 1,850 index tuples is 21 blocks — which is why
-- db:check-build-reads gained a `forbidSort` assertion in the same change.
--
-- WHY RESHAPE RATHER THAN ADD
--
-- idx_tickets_org_project_rank_sort's key columns are IDENTICAL to
-- idx_tickets_org_project_rank_covering's — (org_id, project_id, rank, created_at DESC, id),
-- both partial on deleted_at IS NULL — and _covering's INCLUDE list is a superset. So every
-- read that wants the templated (rank, created_at DESC, id) order still gets an Index Only
-- Scan after this migration; measured on the same fixture, a
-- `ORDER BY rank, created_at DESC, id LIMIT 101` planned as
-- `Index Only Scan using idx_tickets_org_project_rank_covering, Heap Fetches: 0, 7 buffers`.
-- build.tickets already carries 25 indexes; this keeps the count flat and the new shape is
-- SMALLER (1,968 kB -> 1,760 kB on the fixture).
--
-- created_at is a trailing KEY column rather than INCLUDE because the board page projects it
-- (listTicketsByCursor selects id, rank, rank, created_at) and an Index Only Scan needs it in
-- the index; a trailing key column is also expressible in the Drizzle declaration, which
-- INCLUDE is not. Its position after `id` is deliberate: it must not come between the two
-- columns the ORDER BY names, which is the whole defect being fixed.
--
-- The auditor's alternative — (org_id, project_id, rank, id) with no created_at at all — was
-- measured and REJECTED: the planner refused it and stayed on the old index with the
-- Incremental Sort, because without created_at the scan cannot be index-only for this
-- projection and a heap fetch per row costs more than sorting 1,850 index tuples.
--
-- OPERATOR: on a live table, run the CONCURRENTLY forms BY HAND first, in this order — the
-- new index exists before the old one goes, so there is never a window with no rank index.
-- The guards below then make this migration a no-op (precedent: 0575, 0374).
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_org_project_rank_id"
--     ON build."tickets" ("org_id", "project_id", "rank" ASC, "id" ASC, "created_at" DESC)
--     WHERE "deleted_at" IS NULL;
--   DROP INDEX CONCURRENTLY IF EXISTS build."idx_tickets_org_project_rank_sort";
--
-- An Index Only Scan also needs the visibility map, which a bulk-loaded table does not have.
--   OPERATOR: VACUUM ANALYZE build."tickets";   -- cannot run inside a transaction block

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_rank_id"
  ON build."tickets" ("org_id", "project_id", "rank" ASC, "id" ASC, "created_at" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build."idx_tickets_org_project_rank_sort";
--> statement-breakpoint

-- Fail loudly rather than leave the board on a shape that cannot carry its ORDER BY.
DO $$
DECLARE
  key_columns text;
  predicate   text;
  covering_ok boolean;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid), pg_get_expr(x.indpred, x.indrelid)
    INTO key_columns, predicate
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_tickets_org_project_rank_id'
     AND x.indrelid = 'build.tickets'::regclass;

  IF NOT FOUND THEN
    RAISE EXCEPTION '1059: idx_tickets_org_project_rank_id was not created';
  END IF;

  -- `rank` must be followed immediately by `id`. Anything between them and the board is
  -- back to an Incremental Sort over the whole project.
  IF key_columns !~ 'rank, id' THEN
    RAISE EXCEPTION
      '1059: idx_tickets_org_project_rank_id does not lead (rank, id) — the board ORDER BY is uncarried again. indexdef = %',
      key_columns;
  END IF;

  IF predicate IS NULL THEN
    RAISE EXCEPTION
      '1059: idx_tickets_org_project_rank_id lost its deleted_at IS NULL predicate; every read filters on it';
  END IF;

  -- Dropping _sort is only safe because _covering carries the same key columns.
  SELECT true INTO covering_ok
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_tickets_org_project_rank_covering'
     AND x.indrelid = 'build.tickets'::regclass;

  IF covering_ok IS NOT TRUE THEN
    RAISE EXCEPTION
      '1059: idx_tickets_org_project_rank_covering is missing, so dropping idx_tickets_org_project_rank_sort leaves the (rank, created_at DESC, id) order with no index at all';
  END IF;
END
$$;
