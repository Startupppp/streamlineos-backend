-- 0988 DOWN — removes the tenant-isolation policies and disables RLS, returning the four tables to org-wide readability.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON build.git_webhook_seen_deliveries;
--> statement-breakpoint
ALTER TABLE build.git_webhook_seen_deliveries DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.calendar_provider_sync_queue;
--> statement-breakpoint
ALTER TABLE public.calendar_provider_sync_queue DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.file_quarantine_records;
--> statement-breakpoint
ALTER TABLE public.file_quarantine_records DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.multipart_upload_intents;
--> statement-breakpoint
ALTER TABLE public.multipart_upload_intents DISABLE ROW LEVEL SECURITY;
