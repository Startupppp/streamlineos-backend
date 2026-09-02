-- 0976_ar02_declared_tenant_uniques DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_wfh_requests_user_date" ON "wfh_requests" USING btree ("user_id","date");
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_support_ticket_watchers_ticket_membership";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_payroll_filings_entity_period_type";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_onboarding_documents_org_user_type_version";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_mood_org_membership_date";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_hr_employments_org_id_person";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_wfh_requests_org_user_date";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_workers_org_person_worker";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_notification_events_org_id";
