-- Rollback for 1113_inv_3pl_connections_credentials.
--
-- The forward migration added api_credential_encrypted, api_credential_hint,
-- and webhook_secret_encrypted to inv_3pl_connections.
--
-- DATA LOSS: Dropping these columns permanently destroys every stored provider
-- credential for 3PL connections. After applying this rollback all 3PL connection
-- operators must re-enter their provider credentials.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS api_credential_encrypted;
--> statement-breakpoint
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS api_credential_hint;
--> statement-breakpoint
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS webhook_secret_encrypted;
