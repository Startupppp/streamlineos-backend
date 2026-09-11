-- 1060 DOWN — drops the pending-reminder index.
--
-- @reopens-a-defect: the due-reminder cron goes back to a parallel sequential scan of
-- every reminder ever written in every tenant, once per organisation per tick. Measured on
-- 500,000 rows: 4,274 shared buffers against 104 with the index, and the gap grows with
-- history because nothing sweeps sent or cancelled rows.
--
-- No data is at risk in either direction; this file adds and removes an index only.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_chat_reply_reminders_pending";
