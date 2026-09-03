-- 1060 — the due-reminder cron gets an index it can actually use.
--
-- `ChatReplyRemindersService.processDueReminders` runs, once per organisation through
-- `forEachOrg`:
--
--     SELECT … FROM chat_reply_reminders
--      WHERE org_id = ? AND remind_at <= now()
--        AND sent_at IS NULL AND cancelled_at IS NULL
--      LIMIT 100
--
-- The only index that names remind_at is `idx_chat_reply_reminders_due (remind_at)` — no
-- org prefix and no status. Almost every historical row satisfies `remind_at <= now()`, so
-- entering on that column selects nearly the whole table and the planner does not bother:
-- it takes a parallel sequential scan and filters. Cost is O(all reminders ever written in
-- every tenant), paid once per organisation on every cron tick, and it grows without bound
-- because nothing sweeps sent or cancelled rows.
--
-- Measured on scratch_bechat_perf, 500,000 reminder rows across three tenants with 99.8%
-- already sent (`EXPLAIN (ANALYZE, BUFFERS)` of the statement above for one org):
--
--   shipped index set   Parallel Seq Scan, Rows Removed by Filter: 115,207 per worker x 3
--                       Buffers: shared hit=4274
--   with this index     Bitmap Index Scan on idx_chat_reply_reminders_pending
--                       Buffers: shared hit=101 read=3
--
-- 41x fewer buffers, and the shape changes from O(history) to O(pending).
--
-- PARTIAL on the pending predicate, and that is the point rather than a size optimisation:
-- the working set is the rows that have NOT been handled, and it stays small no matter how
-- long the table grows. On the measured data the partial index is 48 kB against 5,720 kB
-- for the total `(remind_at)` one. `sent_at`/`cancelled_at` are set by the cron itself, so
-- a handled row leaves the index at the moment it stops being interesting.
--
-- `idx_chat_reply_reminders_due` is KEPT. It is not made redundant by this one: a narrower
-- index under a wider one still wins on different qualifiers, and dropping such an index
-- because it "looks covered" has cost this codebase measured regressions before. Nothing
-- here claims to have measured every reader of remind_at.
--
-- Never an ON CONFLICT arbiter — `scheduleForMessage` arbitrates on
-- `uniq_chat_reply_reminder` — so the partial predicate cannot cause the 42P10 class of
-- failure that 1054 and 1058 had to account for.
--
-- lock_timeout rather than CONCURRENTLY: drizzle-kit wraps the file in one transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. The build takes a SHARE lock on
-- chat_reply_reminders, which blocks writes to that table for its duration; the table is
-- append-only from a post-commit hook and the partial index covers only pending rows, so
-- the build is small.

SET lock_timeout = '5s';
--> statement-breakpoint

SET statement_timeout = 0;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_chat_reply_reminders_pending"
  ON "chat_reply_reminders" ("org_id", "remind_at")
  WHERE "sent_at" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint

-- Read the catalog back: IF NOT EXISTS hides a no-op and db:migrate reports success over one.
DO $$
DECLARE
  predicate text;
BEGIN
  SELECT pg_get_expr(x.indpred, x.indrelid) INTO predicate
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_chat_reply_reminders_pending'
     AND x.indrelid = 'chat_reply_reminders'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1060: idx_chat_reply_reminders_pending was not created';
  END IF;
  IF predicate IS NULL THEN
    RAISE EXCEPTION '1060: idx_chat_reply_reminders_pending lost its pending predicate — it would then grow with all history, which is the defect it exists to fix';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_chat_reply_reminders_due'
  ) THEN
    RAISE EXCEPTION '1060: idx_chat_reply_reminders_due is gone — this migration adds an index, it does not replace one';
  END IF;
END
$$;
