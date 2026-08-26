-- The shared secret a provider signs its push notifications with.
--
-- Ticket 11's near-real-time half. A push endpoint is unauthenticated by nature
-- — the provider has no session — so the only thing standing between it and any
-- caller who can guess a mailbox address is a signature. The secret therefore
-- has to live somewhere the endpoint can reach it *after* it knows which
-- mailbox is being talked about, which means on the mailbox row.
--
-- Per-mailbox rather than one deployment-wide secret in the environment,
-- following `web-form-submission`, which keeps its secret on the registration
-- row for the same reason: one global secret means a leak from any tenant's
-- integrator is a key to every other tenant's ingress, and rotating it takes
-- every mailbox down at once.
--
-- Nullable, because a mailbox that has never registered a push subscription has
-- no secret and must not get a usable one by default. `readPush` compares in
-- constant time and a null secret can never match, so an unregistered mailbox
-- fails closed without a special case.
--
-- Authored via `generate --custom`; `db:generate` cannot run in this repo.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "crm_mailbox_sync" ADD COLUMN IF NOT EXISTS "push_secret" text;

--> statement-breakpoint
/*
 * The lookup a push does: provider plus the address the provider names.
 *
 * Leads with `organization_id` like every other composite index here — but a
 * push arrives without a tenant, so this one is *also* useful without it, which
 * is why `(provider, mailbox_address)` is its own index rather than a suffix of
 * the tenant one. Partial on `enabled`, because a disabled mailbox is not a
 * push target and the index should not carry it.
 */
CREATE INDEX IF NOT EXISTS "idx_crm_mailbox_sync_push_lookup"
  ON "crm_mailbox_sync" ("provider", "mailbox_address")
  WHERE "enabled" = true;
