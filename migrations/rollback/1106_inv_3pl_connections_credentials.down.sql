SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS api_credential_encrypted;
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS api_credential_hint;
ALTER TABLE inv_3pl_connections DROP COLUMN IF EXISTS webhook_secret_encrypted;
