-- 0996 DOWN — removes the three leading tenant indexes.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_communication_backfill_issues_org_created;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_subprocessor_subscribers_org_created;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_support_ticket_tags_org_ticket;
