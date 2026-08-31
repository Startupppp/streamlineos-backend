-- 0605 — Fix cross-tenant DoS: scope provider_webhook_events uniqueness to (org_id, provider, provider_event_id)
--
-- The existing index is:
--   UNIQUE INDEX uq_provider_webhook_events_provider_event
--     ON public.provider_webhook_events (provider, provider_event_id)
--
-- A unique index enforces regardless of RLS, so one tenant could pre-insert another
-- tenant's provider_event_id and have that org's genuine event silently rejected as a
-- duplicate. backend/CLAUDE.md §3: "a bare global .unique() lets one tenant's value
-- block every other org (cross-tenant DoS + info leak)".
--
-- The counter-argument — a Razorpay event ID is the provider's global identifier and
-- should never legitimately repeat across orgs — holds for a single-account deployment
-- but fails the moment the platform runs more than one provider account or a shared
-- sandbox is used. More importantly the schema rule exists to prevent reasoning about
-- per-case exploitability.
--
-- Fix: make the constraint composite (org_id, provider, provider_event_id). The
-- ProviderEventLedger.claim() FOREIGN branch is dead after this change: the new index
-- scopes conflicts to one org, so a different org's row can never conflict.
--
-- NOTE ON CONCURRENCY: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- On a live production table this should be run outside the migration transaction as
-- CREATE INDEX CONCURRENTLY before the migration applies (with IF NOT EXISTS it becomes
-- a no-op inside the migration). This table is small in practice — one row per webhook
-- event, retained only until acknowledged.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_provider_webhook_events_provider_event";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_webhook_events_provider_event"
  ON "provider_webhook_events" ("org_id", "provider", "provider_event_id");
