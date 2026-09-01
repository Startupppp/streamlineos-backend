-- Rollback 0844: drop the outbox recipient column.
--
-- DATA LOSS on the way down, and it is acceptable: the column records which member a queued email
-- is for, and the queue drains in minutes. Rolling back discards recipient identity for whatever
-- is in flight at that moment, which costs those rows their retry-time re-authorisation and
-- nothing else — they fall back to the pre-0844 behaviour of sending on the address alone.
--
-- Roll the code back first. `EmailOutboxService.processRetries` reads this column, so dropping it
-- under a running deployment fails 42703 on the next retry sweep.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "email_outbox" DROP COLUMN IF EXISTS "recipient_user_id";
