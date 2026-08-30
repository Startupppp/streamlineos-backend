SET lock_timeout = '5s';
ALTER TABLE public.mail_sync_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.mail_sync_checkpoints FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.payroll_run_export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payroll_run_export_jobs FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
