-- The "my work" dashboard reads tickets by tenant + assignee, newest first, ten at a time:
--
--   WHERE t.org_id = $1 AND t.assignee_membership_id = $2 AND t.deleted_at IS NULL
--   [AND t.status IN (...)]  ORDER BY t.updated_at DESC LIMIT 10
--
-- Two read-cost budgets declare that shape: `dashboard-my-issues` (no status filter) and
-- `dashboard-personal-my-tasks` (with one). At head no index serves both halves.
-- `idx_tickets_org_assignee_status` (org_id, assignee_membership_id, status) filters but cannot
-- order; `idx_tickets_org_updated_live` (org_id, updated_at DESC, id) WHERE deleted_at IS NULL
-- orders but does not filter by assignee. The majority tenant takes the second and walks the
-- organisation's whole recency list looking for one person's ten newest rows.
--
-- MEASURED, not reasoned about. `scratch_t07c`, a copy of the production-shaped seed
-- (20,572 tickets across four tenants at 18,500 / 1,850 / 185 / 37 rows -- 89.93 / 9.00 / 0.90 /
-- 0.18 percent), VACUUM ANALYZEd, probed as `streamline_app` (rolbypassrls = false) with the
-- tenant GUC set, in BUFFERS, on every tenant, warm (third of three samples), with the index
-- created and dropped around the measurement.
--
--   `dashboard-my-issues`, the budget that returns rows on this seed:
--
--   tenant     head    (org,assignee,status,updated DESC)   THIS INDEX
--   89.93%      261                                  261           22
--    9.00%       40                                   40           19
--    0.90%      175                                  175           75
--    0.18%       61                                   61           60
--
--   the same query with the status filter, using the seed's own status vocabulary:
--
--   89.93%      252                                  252           13
--    9.00%       34                                   34           13
--    0.90%       31                                   31           15
--    0.18%       10                                   10           10
--
-- Rows scanned on `build.tickets` at the majority tenant fall from 1,801 to 10 -- ten returned and
-- 1,791 discarded by an assignee filter the index now applies itself.
--
-- The obvious candidate -- appending `updated_at DESC` to the existing
-- (org_id, assignee_membership_id, status) index -- **changes nothing on any tenant**, and that is
-- the point: it reproduces the head column exactly, and the majority tenant declines it outright
-- and keeps walking `idx_tickets_org_updated_live`. A `status` key between the equality columns
-- and the sort column means the index cannot return rows already ordered by `updated_at`, so
-- LIMIT 10 cannot stop early. Leaving `status` out is what makes the ordering usable: the index
-- delivers the tenant's assignee rows newest-first, LIMIT 10 stops after ten, and `status` is a
-- cheap recheck on those ten.
--
-- The index is chosen on all four tenants and is never worse than head on any of them. That is
-- the inverse of the pattern that made 0999's seven drops regressions, where the effect appeared
-- only at the large tenant. It costs 440 kB against a 3,584 kB heap.
--
-- Partial on `deleted_at IS NULL` because every read filters it and the partial index stays small.
--
-- Note for whoever next reads the budget output: `dashboard-personal-my-tasks` is VACUOUS on the
-- perf seed and stays vacuous after this index. Its predicate is the application's UPPER_SNAKE
-- (`'TODO','IN_PROGRESS','IN_REVIEW'`) and the seed writes title-case (`'Todo','In Progress'`), so
-- it matches zero rows. That is a seed-vocabulary defect in `src/scripts/`, not an index defect,
-- and this migration does not close it.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Not CONCURRENTLY: db:migrate runs inside a transaction.
CREATE INDEX IF NOT EXISTS idx_tickets_org_assignee_updated_live
  ON build.tickets (org_id, assignee_membership_id, updated_at DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.relname = 'idx_tickets_org_assignee_updated_live'
      AND n.nspname = 'build' AND c.relname = 'tickets'
      AND x.indpred IS NOT NULL
      AND (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
             FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum)
          = 'org_id, assignee_membership_id, updated_at')
  THEN
    RAISE EXCEPTION
      '1027: idx_tickets_org_assignee_updated_live is missing, not partial, or does not cover (org_id, assignee_membership_id, updated_at) — a CREATE INDEX IF NOT EXISTS name collision looks exactly like success';
  END IF;
END
$$;
