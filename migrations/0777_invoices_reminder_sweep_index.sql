SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoices_org_due_status"
  ON "invoices" ("org_id", "due_date", "status")
  WHERE "status" IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') AND "due_date" IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_invoices_org_due_status'
      AND c.relkind = 'i'
  ) THEN
    RAISE EXCEPTION '0777: idx_invoices_org_due_status was not created';
  END IF;
END $$;
