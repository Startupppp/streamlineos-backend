CREATE TABLE IF NOT EXISTS multipart_upload_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mui_org_created ON multipart_upload_intents(org_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_mui_upload_id ON multipart_upload_intents(upload_id);
