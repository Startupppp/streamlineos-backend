-- 0538.down — Revert webhook delivery durability.
--
-- Reverses the retry/lease/dead-letter columns on inv_webhook_events and the
-- failure-tracking columns on inv_webhooks, plus the three indexes over them.
--
-- The forward migration also back-stamped existing FAILED events as dead
-- lettered. Dropping the columns discards that, and every delivery attempt,
-- lease and error string recorded since. Declared, not discovered:
--
-- @data-loss: inv_webhook_events, inv_webhooks
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_whe_org_webhook_dedupe";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_whe_due";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_whe_dead";
--> statement-breakpoint
ALTER TABLE "inv_webhook_events"
  DROP COLUMN IF EXISTS "dedupe_key",
  DROP COLUMN IF EXISTS "next_attempt_at",
  DROP COLUMN IF EXISTS "lease_expires_at",
  DROP COLUMN IF EXISTS "last_attempt_at",
  DROP COLUMN IF EXISTS "last_error",
  DROP COLUMN IF EXISTS "dead_lettered_at";
--> statement-breakpoint
ALTER TABLE "inv_webhooks"
  DROP COLUMN IF EXISTS "consecutive_failures",
  DROP COLUMN IF EXISTS "failing_since",
  DROP COLUMN IF EXISTS "alerted_at",
  DROP COLUMN IF EXISTS "disabled_at",
  DROP COLUMN IF EXISTS "disabled_reason";
