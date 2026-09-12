SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_org_people_active_work_email_ci";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_workers_active_org_number";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_hr_employments_org_engagement_link";
