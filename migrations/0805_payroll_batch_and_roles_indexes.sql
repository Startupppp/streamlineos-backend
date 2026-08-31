SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_bank_batches_org_generated_at
  ON payroll_bank_batches (org_id, generated_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_roles_org_module_name_id
  ON roles (org_id, module_key, name, id);
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.name, ', ') INTO missing
  FROM (VALUES
    ('idx_payroll_bank_batches_org_generated_at'),
    ('idx_roles_org_module_name_id')
  ) AS expected(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = expected.name
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0805: keyset sort index missing, the page-2 sort will not use an index: %', missing;
  END IF;
END $$;
