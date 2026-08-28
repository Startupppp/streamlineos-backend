-- Four tenant tables had no org_id-leading index; under RLS the policy qual cannot be answered from a non-tenant-leading index.
-- lock_timeout prevents the index build from queueing behind a long-running query and blocking the whole table.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidate_resumes_org_candidate"
  ON "candidate_resumes" ("org_id", "candidate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_note_items_org_cn"
  ON "credit_note_items" ("org_id", "credit_note_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fin_payment_run_items_org_run"
  ON "fin_payment_run_items" ("org_id", "run_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vendor_credit_items_org_vc"
  ON "vendor_credit_items" ("org_id", "vendor_credit_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_credit_note_items_cn";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_vendor_credit_items_vc";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_fin_payment_run_items_run";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_candidate_resumes_org_candidate') THEN
    RAISE EXCEPTION 'index idx_candidate_resumes_org_candidate is missing after migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_credit_note_items_org_cn') THEN
    RAISE EXCEPTION 'index idx_credit_note_items_org_cn is missing after migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_fin_payment_run_items_org_run') THEN
    RAISE EXCEPTION 'index idx_fin_payment_run_items_org_run is missing after migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_vendor_credit_items_org_vc') THEN
    RAISE EXCEPTION 'index idx_vendor_credit_items_org_vc is missing after migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname IN ('idx_credit_note_items_cn', 'idx_vendor_credit_items_vc', 'idx_fin_payment_run_items_run')
  ) THEN
    RAISE EXCEPTION 'a superseded non-tenant-leading index survived the migration';
  END IF;
END $$;
