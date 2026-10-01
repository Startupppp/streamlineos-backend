SET lock_timeout = '5s';
--> statement-breakpoint

-- Restore BOTH halves of the grain `0300_timesheets_launch_grade` established and
-- `0824` lost.
--
-- 0300 dropped `uniq_timesheets_work_log` on purpose: on (org_id, user_id, date)
-- with `WHERE ticket_id IS NULL` it allowed only ONE ticketless entry per person
-- per day org-wide, which breaks multi-project day logging, and it counted voided
-- rows, so a void kept holding its day. It replaced the one index with two —
-- `uniq_timesheets_day_project` (one live entry per person, day and project) and
-- `uniq_timesheets_day_blank` (one live project-less entry per person per day).
--
-- `0824`'s `DROP COLUMN user_id` auto-dropped both of them, because both were
-- defined on `user_id`, and 0824:109-111 rebuilt only the over-broad one on
-- `user_membership_id`. `uniq_timesheets_day_project` and
-- `uniq_timesheets_day_blank` do not exist on any database today.
--
-- So two distinct defects were live, not one:
--   BUG-TS-BE-006  a voided entry kept holding its day; the next entry got 23505.
--   per-project    two LIVE ticketless entries for the same person and day on
--                  DIFFERENT projects collided, because project_id is not in the
--                  key and not in the predicate:
--                    duplicate key value violates unique constraint
--                      "uniq_timesheets_work_log"
--                    DETAIL: Key (org_id, user_membership_id, date)=(…) already exists.
--
-- `uniq_timesheets_work_log` keeps its name and becomes 0300's blank-day index:
-- the name is referenced from `src/db/schema/timesheets/entries.ts` (BUG-TS-BE-007
-- explains why the plain range index beside it is not redundant), and renaming it
-- would churn that without buying anything.
--
-- ON CONFLICT inference is the reason the blank index must carry
-- `project_id IS NULL` rather than merely tolerate it. The only upsert onto this
-- index — `src/modules/hr/time/work-logs.service.ts:172` — names
-- `target: (org_id, user_membership_id, date)` with
-- `targetWhere: ticket_id IS NULL AND project_id IS NULL AND voided_at IS NULL`.
-- PostgreSQL infers a partial index only when the index predicate is IMPLIED BY
-- that clause, so the predicate below is exactly it. The per-project index carries
-- a fourth key column, so it is never a candidate for that three-column target and
-- the inference stays unambiguous.
DROP INDEX IF EXISTS "uniq_timesheets_work_log";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_work_log"
  ON "timesheets" ("org_id", "user_membership_id", "date")
  WHERE ticket_id IS NULL AND project_id IS NULL AND voided_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_day_project"
  ON "timesheets" ("org_id", "user_membership_id", "date", "project_id")
  WHERE ticket_id IS NULL AND project_id IS NOT NULL AND voided_at IS NULL;
