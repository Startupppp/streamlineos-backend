SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE inv_channels ADD COLUMN IF NOT EXISTS api_credential_encrypted text;
ALTER TABLE inv_channels ADD COLUMN IF NOT EXISTS api_credential_hint text;
ALTER TABLE inv_channels ADD COLUMN IF NOT EXISTS webhook_secret_encrypted text;
