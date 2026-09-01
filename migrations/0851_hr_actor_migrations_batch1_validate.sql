-- 0851: VALIDATE NOT VALID FK constraints from migrations 0845-0850.
--
-- VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (not ACCESS EXCLUSIVE), so it
-- can run while the table is still writable. It proves that every existing row satisfies
-- the FK before we can tighten to NOT NULL. Run after backfill is confirmed complete.
-- Each VALIDATE is a separate statement so a single failure doesn't abort the rest.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_covering_actor";

--> statement-breakpoint
ALTER TABLE "wfh_requests" VALIDATE CONSTRAINT "fk_wfh_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" VALIDATE CONSTRAINT "fk_hr_attendance_regularizations_user_actor";

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "fk_documents_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" VALIDATE CONSTRAINT "fk_hr_cases_assigned_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases" VALIDATE CONSTRAINT "fk_hr_cases_reported_by_actor";

--> statement-breakpoint
ALTER TABLE "resignations" VALIDATE CONSTRAINT "fk_resignations_user_actor";
