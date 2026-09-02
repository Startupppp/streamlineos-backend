-- The recurring-event branch of the calendar list predicate and reminder sweep
-- both run a query of the shape:
--
--   WHERE org_id = $1 AND rrule IS NOT NULL AND start_date < $end
--     AND (recurrence_end IS NULL OR recurrence_end > $start)
--   ORDER BY start_date ASC, id ASC
--
-- Column order follows the access pattern: equality (org_id), then the range
-- predicate that is also the leading sort column (start_date — no explicit sort
-- node when the index supplies it), then the residual filter (recurrence_end —
-- carried in the index so the planner can evaluate it without a heap trip).
-- A btree can range-scan only the first inequality column after the equality
-- prefix; placing start_date there lets the planner satisfy both the range and
-- the ORDER BY from the index in one pass. recurrence_end as the third column
-- is evaluated as a residual inside the index page, costing no additional I/O.
--
-- The partial predicate (rrule IS NOT NULL) matches the query's own recurring
-- branch exactly, which is a requirement for the planner to use the index.
-- It also shrinks the index to recurring rows only; a full index would carry
-- non-recurring rows that can never satisfy this branch.
--
-- org_id leads because the planner requires it on any RLS table: the RLS policy
-- adds org_id = app.current_org_id(), which is not leakproof, so without org_id
-- in the index the planner refuses an index-only scan outright. calendar_events
-- has no RLS policy today (noted in 0508), but every existing index on this
-- table leads with org_id and this one follows suit for when RLS is added.
--
-- UNMEASURED: the dev database has 100 calendar_events rows and 0 recurring
-- ones, so no plan comparison (EXPLAIN ANALYZE as streamline_app with the
-- tenant GUC) was possible. The ordering is reasoned from access-pattern
-- principles, not measured on real data.
--
-- Not CONCURRENTLY: db:migrate wraps each file in a transaction and
-- CREATE INDEX CONCURRENTLY is rejected inside one (backend/CLAUDE.md §3;
-- established pattern 0746/0575/0674). The table has 100 rows; the lock
-- window is negligible.
--
-- lock_timeout: 5s — fails fast rather than queuing behind long reads.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "idx_calendar_events_org_recurrence_end"
  ON "calendar_events" ("org_id", "start_date", "recurrence_end")
  WHERE rrule IS NOT NULL;
