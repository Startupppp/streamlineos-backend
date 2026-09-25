SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'kb_pages'
  ), 'kb_pages table must exist before this migration';
END $$;
--> statement-breakpoint

ALTER TABLE "kb_pages"
  ADD COLUMN IF NOT EXISTS "legal_hold" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "legal_hold_reason" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_legal_hold"
  ON "kb_pages" ("org_id", "legal_hold")
  WHERE "legal_hold" = true;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kb_pages' AND column_name = 'legal_hold'
  ), 'legal_hold column must exist after this migration';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kb_pages' AND column_name = 'legal_hold_reason'
  ), 'legal_hold_reason column must exist after this migration';
END $$;
