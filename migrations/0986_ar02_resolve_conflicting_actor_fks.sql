-- AR-02: one canonical actor constraint per relationship. Each pair had an undeclared RESTRICT constraint beside a declared SET NULL one, so RESTRICT was already the effective behaviour; the declared name is kept and given RESTRICT to match its Drizzle declaration.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations DROP CONSTRAINT IF EXISTS "fk_hr_actor_62ea7f42453f8bec";
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations DROP CONSTRAINT IF EXISTS "fk_hr_workflow_delegations_delegate_actor";
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations
  ADD CONSTRAINT "fk_hr_workflow_delegations_delegate_actor"
  FOREIGN KEY (org_id, delegate_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegate_actor";
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations DROP CONSTRAINT IF EXISTS "fk_hr_actor_d2da51a407540eda";
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations DROP CONSTRAINT IF EXISTS "fk_hr_workflow_delegations_delegator_actor";
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations
  ADD CONSTRAINT "fk_hr_workflow_delegations_delegator_actor"
  FOREIGN KEY (org_id, delegator_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_delegations VALIDATE CONSTRAINT "fk_hr_workflow_delegations_delegator_actor";
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions DROP CONSTRAINT IF EXISTS "fk_hr_actor_56f88a7c70579140";
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions DROP CONSTRAINT IF EXISTS "fk_hr_workflow_step_actions_acted_by_actor";
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions
  ADD CONSTRAINT "fk_hr_workflow_step_actions_acted_by_actor"
  FOREIGN KEY (org_id, acted_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions VALIDATE CONSTRAINT "fk_hr_workflow_step_actions_acted_by_actor";
--> statement-breakpoint
ALTER TABLE performance_reviews DROP CONSTRAINT IF EXISTS "fk_hr_actor_3a11937777fce680";
--> statement-breakpoint
ALTER TABLE performance_reviews DROP CONSTRAINT IF EXISTS "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint
ALTER TABLE performance_reviews
  ADD CONSTRAINT "fk_performance_reviews_reviewer_actor"
  FOREIGN KEY (org_id, reviewer_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE performance_reviews VALIDATE CONSTRAINT "fk_performance_reviews_reviewer_actor";
--> statement-breakpoint
ALTER TABLE recognitions DROP CONSTRAINT IF EXISTS "fk_hr_actor_70e5b323f13d92c3";
--> statement-breakpoint
ALTER TABLE recognitions DROP CONSTRAINT IF EXISTS "fk_recognitions_from_actor";
--> statement-breakpoint
ALTER TABLE recognitions
  ADD CONSTRAINT "fk_recognitions_from_actor"
  FOREIGN KEY (org_id, from_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recognitions VALIDATE CONSTRAINT "fk_recognitions_from_actor";
--> statement-breakpoint
ALTER TABLE recognitions DROP CONSTRAINT IF EXISTS "fk_hr_actor_e356c99849d85055";
--> statement-breakpoint
ALTER TABLE recognitions DROP CONSTRAINT IF EXISTS "fk_recognitions_to_actor";
--> statement-breakpoint
ALTER TABLE recognitions
  ADD CONSTRAINT "fk_recognitions_to_actor"
  FOREIGN KEY (org_id, to_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recognitions VALIDATE CONSTRAINT "fk_recognitions_to_actor";
--> statement-breakpoint
ALTER TABLE hr_mood_checkins DROP CONSTRAINT IF EXISTS "fk_hr_actor_43899b1d388aec8d";
--> statement-breakpoint
ALTER TABLE hr_mood_checkins DROP CONSTRAINT IF EXISTS "fk_hr_mood_checkins_user_actor";
--> statement-breakpoint
ALTER TABLE hr_mood_checkins
  ADD CONSTRAINT "fk_hr_mood_checkins_user_actor"
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_mood_checkins VALIDATE CONSTRAINT "fk_hr_mood_checkins_user_actor";
