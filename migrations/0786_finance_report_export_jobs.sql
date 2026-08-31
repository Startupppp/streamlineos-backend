SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_report_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_membership_id integer NOT NULL,
  report_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  filters jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  file_key text,
  file_name text,
  mime_type text NOT NULL DEFAULT 'text/csv',
  file_size_bytes bigint,
  processed_rows integer NOT NULL DEFAULT 0,
  row_count integer,
  truncated boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error_code text,
  error_message text,
  locked_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_fin_report_export_jobs_status CHECK (status IN ('pending','running','completed','failed','expired')),
  CONSTRAINT chk_fin_report_export_jobs_report_type CHECK (report_type IN ('vendor_statement','customer_statement','sales_by_customer','sales_by_item','expense_by_category','tax_summary','project_profitability','department_profitability','budget_vs_actual')),
  CONSTRAINT chk_fin_report_export_jobs_counts CHECK (processed_rows >= 0 AND (row_count IS NULL OR row_count >= 0)),
  CONSTRAINT chk_fin_report_export_jobs_attempts CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE finance_report_export_jobs
  ADD CONSTRAINT fin_report_export_jobs_org_requester_membership_fk
  FOREIGN KEY (org_id, requested_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE finance_report_export_jobs
  VALIDATE CONSTRAINT fin_report_export_jobs_org_requester_membership_fk;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fin_report_export_jobs_org_idempotency
  ON finance_report_export_jobs(org_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_report_export_jobs_org_status_created
  ON finance_report_export_jobs(org_id, status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_report_export_jobs_org_requester_created
  ON finance_report_export_jobs(org_id, requested_by_membership_id, created_at);
--> statement-breakpoint
ALTER TABLE public.finance_report_export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "finance_report_export_jobs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "finance_report_export_jobs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "finance_report_export_jobs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_report_export_jobs" TO streamline_app;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'finance_report_export_jobs'
      AND c.relrowsecurity
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  ) THEN
    RAISE EXCEPTION '0786: finance_report_export_jobs still lacks RLS or a policy';
  END IF;
END $$;
