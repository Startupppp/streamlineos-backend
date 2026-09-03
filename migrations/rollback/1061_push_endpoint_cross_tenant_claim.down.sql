SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Reverses 1061. Dropping the resolver restores the pre-1061 behaviour exactly:
-- `POST /push/subscribe` answers 500 again for any browser whose endpoint is
-- already registered against a different tenant, because RLS hides that row from
-- every statement the app role can write. Nothing else depends on the function —
-- it is called from one place, `PushService.subscribe` — and it owns no data, so
-- the drop is complete and carries no data loss.

DROP FUNCTION IF EXISTS app.claim_push_endpoint(text);
