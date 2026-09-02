-- AR-02: create the tenant-scoped unique constraints the Drizzle model declares but the database never enforced, and drop the cross-tenant wfh_requests(user_id, date) index they supersede.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_events_org_id" ON "notification_events" ("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workers_org_person_worker" ON "workers" ("organization_id", "organization_person_id", "worker_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_wfh_requests_org_user_date" ON "wfh_requests" ("org_id", "user_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_employments_org_id_person" ON "hr_employments" ("org_id", "id", "person_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mood_org_membership_date" ON "hr_mood_checkins" ("org_id", "user_membership_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_onboarding_documents_org_user_type_version" ON "onboarding_documents" ("org_id", "user_id", "document_type_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_filings_entity_period_type" ON "payroll_filings" ("org_id", "entity_id", "period_id", "filing_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_watchers_ticket_membership" ON "support_ticket_watchers" ("ticket_id", "user_membership_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_wfh_requests_user_date";
