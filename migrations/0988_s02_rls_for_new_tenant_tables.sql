-- S02: enable tenant isolation on four tenant tables that shipped without any RLS policy; streamline_app holds full DML on each, so until now every row was readable org-wide.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.git_webhook_seen_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON build.git_webhook_seen_deliveries;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON build.git_webhook_seen_deliveries
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
--> statement-breakpoint
ALTER TABLE public.calendar_provider_sync_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.calendar_provider_sync_queue;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.calendar_provider_sync_queue
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
--> statement-breakpoint
ALTER TABLE public.file_quarantine_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.file_quarantine_records;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.file_quarantine_records
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
--> statement-breakpoint
ALTER TABLE public.multipart_upload_intents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.multipart_upload_intents;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.multipart_upload_intents
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
