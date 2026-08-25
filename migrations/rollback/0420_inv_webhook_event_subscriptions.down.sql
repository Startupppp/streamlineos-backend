-- 0420.down — Revert webhook event subscriptions. inv_webhooks.events was never
-- dropped, so no data is lost.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_webhook_event_subs_dispatch";
DROP INDEX IF EXISTS "uniq_inv_webhook_event_subs_key";
DROP TABLE IF EXISTS "inv_webhook_event_subscriptions";
