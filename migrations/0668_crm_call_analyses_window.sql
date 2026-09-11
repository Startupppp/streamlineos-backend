-- Custom SQL migration file, put your code below! --

-- The index every aggregate over `crm_call_analyses` has always needed.
--
-- CRM-P2-05 / CRM-P2-06. No new table, and that is the point: a per-rep summary
-- and a best-call search are both a window over the analyses that already exist,
-- so a materialised `crm_call_rep_metrics` would be a second copy of the same
-- facts that has to be invalidated whenever an analysis lands or an analyser
-- version is bumped -- and a stale copy of a coaching metric is a number
-- somebody quotes at a colleague after the call it came from was re-judged.
--
-- What the three aggregates issue, verbatim:
--
--   SELECT ... FROM crm_call_analyses
--    WHERE organization_id = $1 AND analyzer_version = $2 AND created_at >= $3
--    ORDER BY created_at DESC LIMIT $4
--
-- Neither existing index serves it. `uniq_crm_call_analyses_hash` leads with the
-- organisation and then continues into `transcript_hash`, so any ordering by
-- `created_at` is lost after the first column; `idx_crm_call_analyses_activity`
-- never mentions `created_at`. The planner's only route was a scan of the
-- tenant's analyses plus a sort, which is invisible on a demo org and is the
-- whole table for a tenant with a year of calls.
--
-- `organization_id` leads, and not because of the tenant-key convention alone.
-- The RLS policy installed in 0540 adds `organization_id = app.current_org_id()`
-- to every read; that qual is not leakproof, so it is evaluated against the heap
-- tuple, and an index that did not itself supply `organization_id` could never
-- support an index-only scan. `analyzer_version` is second because it is an
-- equality on a column with a handful of distinct values, and `created_at DESC`
-- is last so the range predicate and the ORDER BY are satisfied by one walk.
--
-- Created non-concurrently, deliberately. `CREATE INDEX CONCURRENTLY` cannot run
-- inside a transaction and `drizzle-kit migrate` wraps every migration in one,
-- so a CONCURRENTLY here would abort the whole run rather than build anything.
-- The `lock_timeout` below is what bounds the cost instead: the build takes a
-- SHARE lock, which blocks writes to this table only, and fails fast rather than
-- queueing behind a long read and blocking every writer behind itself.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_call_analyses_window"
  ON "crm_call_analyses" ("organization_id", "analyzer_version", "created_at" DESC);

--> statement-breakpoint
-- An index the planner has no statistics for is an index the planner declines.
-- `crm_call_analyses` is append-only and lightly vacuumed, so the visibility map
-- is also what decides whether an index-only scan is available at all.
ANALYZE "crm_call_analyses";
