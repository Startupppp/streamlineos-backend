-- The index the thread window reads, and the retirement of the one that could not.
--
-- Ticket 23 gives extraction the neighbouring messages on a thread instead of
-- one activity at a time, which adds exactly one query shape to the hot path of
-- every inbound message:
--
--   SELECT ... FROM activities
--    WHERE organization_id = $1
--      AND thread_id = $2
--      AND (occurred_at, activity_id) <= ($3, $4)
--      AND occurred_at >= $5
--      AND deleted_at IS NULL
--    ORDER BY occurred_at DESC, activity_id DESC
--    LIMIT 10;
--
-- `idx_activities_thread` was ("organization_id", "thread_id") and nothing else,
-- so it could find the thread and then had to hand every row of it to a sort
-- before the LIMIT could throw them away. That is affordable on a mail thread
-- and it is not on a messaging one: `whatsAppThreadIdentity` threads on the pair
-- of phone numbers and never rolls over, so one thread is every message ever
-- exchanged with that customer. A window bounded in the application and
-- unbounded in the plan is not bounded.
--
-- Adding the ordering columns turns it into a range scan that stops after ten
-- rows. The predicate matches the three timeline indexes `0215` created, for the
-- same reason theirs have it: the window excludes deleted activities exactly as
-- a timeline does.
--
-- Replaced rather than added alongside. Nothing in the application read
-- `idx_activities_thread` — the seam wrote `thread_id` and no query filtered on
-- it — so this window is its first reader, and keeping both would charge every
-- activity insert for an index with no reads. The new one carries its columns as
-- a prefix, so the read it was created for is still served.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_thread_window"
  ON "activities" USING btree (
    "organization_id",
    "thread_id",
    "occurred_at" DESC,
    "activity_id" DESC
  )
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_activities_thread";
