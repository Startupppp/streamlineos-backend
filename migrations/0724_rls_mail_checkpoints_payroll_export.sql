SET lock_timeout = '5s';
ALTER TABLE public.mail_sync_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $policy$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mail_sync_checkpoints' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.mail_sync_checkpoints FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
  END IF;
END $policy$;
--> statement-breakpoint
ALTER TABLE public.payroll_run_export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $policy$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'payroll_run_export_jobs' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.payroll_run_export_jobs FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
  END IF;
END $policy$;