-- Rollback 0906: drop workflow delegation and step action membership-id columns.
--
-- @data-loss — the backfilled delegator_membership_id, delegate_membership_id, and
-- acted_by_membership_id pointers are discarded. This is acceptable: the legacy
-- delegator_user_id, delegate_user_id, and acted_by_user_id columns are still present
-- and still populated, so the tables return to a working state.
--
-- Roll the code back first. Services cut over to dual-read the membership columns will
-- fail 42703 on the next read if the columns are dropped under a running deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" DROP CONSTRAINT IF EXISTS "fk_hr_workflow_delegations_delegator_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" DROP CONSTRAINT IF EXISTS "fk_hr_workflow_delegations_delegate_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" DROP CONSTRAINT IF EXISTS "fk_hr_workflow_step_actions_acted_by_actor";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" DROP COLUMN IF EXISTS "delegator_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" DROP COLUMN IF EXISTS "delegate_membership_id";

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" DROP COLUMN IF EXISTS "acted_by_membership_id";
