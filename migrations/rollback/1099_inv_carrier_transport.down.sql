-- Reverses 1099. Drops the two carrier-transport tables and the seven columns
-- it added to `inv_carriers`.
--
-- Read this before running it: it is destructive in one specific way that is
-- worth naming. Dropping `api_credential_encrypted` and
-- `webhook_secret_encrypted` destroys every tenant's courier credential. They
-- are ciphertext, so nothing is disclosed by the drop — but nothing is
-- recoverable from it either, and re-running 1099 afterwards gives every
-- carrier row a NULL credential. Each tenant would have to paste its courier
-- key in again. If that is not what you want, drop the two tables and leave the
-- columns: they are nullable with no default, so they cost nothing to keep.
--
-- Dropping the tables loses the failure history — which bookings a carrier
-- refused, which callbacks were dead-lettered. That history is the ticket's
-- acceptance criterion, so a rollback is also a decision to stop being able to
-- see those failures; it is not recoverable from anywhere else, because the
-- shipment rows are deliberately unchanged by a failed carrier call.
--
-- Policies and indexes go with the tables. `DROP TABLE` removes the RLS policy,
-- both foreign keys and every index on it, so they are not named separately.
--
-- Every statement is `IF EXISTS`, so a re-run is a no-op.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_carrier_webhook_deliveries";
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_carrier_operations";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "webhook_failure_reason";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "webhook_last_failure_at";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "webhook_secret_encrypted";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "api_credential_hint";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "api_credential_encrypted";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "api_base_url";
--> statement-breakpoint
ALTER TABLE "inv_carriers" DROP COLUMN IF EXISTS "transport";
