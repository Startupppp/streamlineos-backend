SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Reverses 1057. Dropping the resolver restores the pre-1057 behaviour exactly:
-- `POST /webhooks/calendar/provider` answers 500 again because the tenant lookup
-- has no way to run without a GUC. Nothing else depends on the function — it is
-- called from one place, `CalendarProviderWebhookService.handleDelivery` — so the
-- drop is complete and carries no data loss.

DROP FUNCTION IF EXISTS app.resolve_calendar_connection_org_id(integer);
