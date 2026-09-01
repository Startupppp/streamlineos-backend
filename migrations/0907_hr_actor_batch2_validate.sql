-- @irreversible
-- 0907: VALIDATE NOT VALID FK constraints from migrations 0902-0906.
--
-- VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (not ACCESS EXCLUSIVE), so it
-- can run while the table is still writable. It proves that every existing row satisfies
-- the FK before we can tighten to NOT NULL. Run after backfill is confirmed complete.
-- Each VALIDATE is a separate statement so a single failure doesn't abort the rest.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" VALIDATE CONSTRAINT "fk_hr_wellness_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" VALIDATE CONSTRAINT "fk_hr_mood_checkins_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" VALIDATE CONSTRAINT "fk_hr_disciplinary_actions_employee_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" VALIDATE CONSTRAINT "fk_hr_proxy_access_grantor_actor";

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" VALIDATE CONSTRAINT "fk_hr_proxy_access_proxy_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" VALIDATE CONSTRAINT "fk_recognitions_from_actor";

--> statement-breakpoint
ALTER TABLE "recognitions" VALIDATE CONSTRAINT "fk_recognitions_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegator_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegate_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" VALIDATE CONSTRAINT "fk_hr_workflow_step_actions_acted_by_actor";
