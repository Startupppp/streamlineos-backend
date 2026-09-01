-- 0906: EXPAND hr_workflow_delegations and hr_workflow_step_actions with membership ids.
--
-- hr_workflow_delegations.delegator_user_id / delegate_user_id: authority-bearing.
-- hr-workflow-delegations.service.ts:34 filters with eq(hrWorkflowDelegations.delegatorUserId, userId)
-- and hr-workflow-approver.service.ts:137 filters with eq(hrWorkflowDelegations.delegateUserId, actorUserId).
-- A revoked member can satisfy either predicate via the global users.id fallback.
--
-- hr_workflow_step_actions.acted_by_user_id: authority-bearing.
-- hr-workflow-instances.service.ts:151,181 filters pending approvals with
-- eq(hrWorkflowStepActions.actedByUserId, userId). A revoked member satisfies this
-- predicate via the global users.id fallback.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Validate migration: 0907_hr_actor_batch2_validate.sql.
-- The legacy user_id columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" ADD COLUMN IF NOT EXISTS "delegator_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" ADD COLUMN IF NOT EXISTS "delegate_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" ADD COLUMN IF NOT EXISTS "acted_by_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_workflow_delegations" wd
SET "delegator_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = wd.org_id
  AND om.user_id = wd.delegator_user_id
  AND wd."delegator_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_workflow_delegations" wd
SET "delegate_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = wd.org_id
  AND om.user_id = wd.delegate_user_id
  AND wd."delegate_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_workflow_step_actions" sa
SET "acted_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = sa.org_id
  AND om.user_id = sa.acted_by_user_id
  AND sa."acted_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations"
  ADD CONSTRAINT "fk_hr_workflow_delegations_delegator_actor"
  FOREIGN KEY ("org_id", "delegator_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("delegator_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations"
  ADD CONSTRAINT "fk_hr_workflow_delegations_delegate_actor"
  FOREIGN KEY ("org_id", "delegate_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("delegate_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions"
  ADD CONSTRAINT "fk_hr_workflow_step_actions_acted_by_actor"
  FOREIGN KEY ("org_id", "acted_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("acted_by_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wf_delegations_org_delegator_membership"
  ON "hr_workflow_delegations" ("org_id", "delegator_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wf_delegations_org_delegate_membership"
  ON "hr_workflow_delegations" ("org_id", "delegate_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wf_actions_org_acted_by_membership"
  ON "hr_workflow_step_actions" ("org_id", "acted_by_membership_id");
