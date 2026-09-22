-- Rollback for 1114_inv_channels_credentials.
--
-- The forward migration added api_credential_encrypted, api_credential_hint,
-- and webhook_secret_encrypted to inv_channels.
--
-- DATA LOSS: Dropping these columns permanently destroys every stored provider
-- credential for inventory channels. After applying this rollback all channel
-- operators must re-enter their provider credentials.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE inv_channels DROP COLUMN IF EXISTS api_credential_encrypted;
--> statement-breakpoint
ALTER TABLE inv_channels DROP COLUMN IF EXISTS api_credential_hint;
--> statement-breakpoint
ALTER TABLE inv_channels DROP COLUMN IF EXISTS webhook_secret_encrypted;
