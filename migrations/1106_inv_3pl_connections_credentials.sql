ALTER TABLE inv_3pl_connections ADD COLUMN IF NOT EXISTS api_credential_encrypted text;
ALTER TABLE inv_3pl_connections ADD COLUMN IF NOT EXISTS api_credential_hint text;
ALTER TABLE inv_3pl_connections ADD COLUMN IF NOT EXISTS webhook_secret_encrypted text;
