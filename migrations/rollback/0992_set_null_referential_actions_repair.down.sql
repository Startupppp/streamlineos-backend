-- 0992 DOWN — restores every referential action to the definition pg_catalog held
-- before the up migration ran. The restored state is the defective one by design:
-- a rollback returns the database to where it was, it does not improve on it.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS fk_support_tickets_created_actor;
--> statement-breakpoint

ALTER TABLE support_tickets
  ADD CONSTRAINT fk_support_tickets_created_actor
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_safety_incidents
  DROP CONSTRAINT IF EXISTS hr_safety_incidents_reported_by_users_id_fk;
--> statement-breakpoint

ALTER TABLE hr_safety_incidents
  ADD CONSTRAINT hr_safety_incidents_reported_by_users_id_fk
  FOREIGN KEY (reported_by)
  REFERENCES users (id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE invitations
  DROP CONSTRAINT IF EXISTS fk_invitations_org_revoked_by_membership;
--> statement-breakpoint

ALTER TABLE invitations
  ADD CONSTRAINT fk_invitations_org_revoked_by_membership
  FOREIGN KEY (org_id, revoked_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_case_notes
  DROP CONSTRAINT IF EXISTS fk_hr_case_notes_author_actor;
--> statement-breakpoint

ALTER TABLE hr_case_notes
  ADD CONSTRAINT fk_hr_case_notes_author_actor
  FOREIGN KEY (org_id, author_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_benefit_enrollments
  DROP CONSTRAINT IF EXISTS fk_hr_benefit_enrollments_user_membership;
--> statement-breakpoint

ALTER TABLE hr_benefit_enrollments
  ADD CONSTRAINT fk_hr_benefit_enrollments_user_membership
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_dependents
  DROP CONSTRAINT IF EXISTS fk_hr_dependents_user_membership;
--> statement-breakpoint

ALTER TABLE hr_dependents
  ADD CONSTRAINT fk_hr_dependents_user_membership
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_insurance_claims
  DROP CONSTRAINT IF EXISTS fk_hr_insurance_claims_user_membership;
--> statement-breakpoint

ALTER TABLE hr_insurance_claims
  ADD CONSTRAINT fk_hr_insurance_claims_user_membership
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_insurance_claims
  DROP CONSTRAINT IF EXISTS fk_hr_insurance_claims_decider_membership;
--> statement-breakpoint

ALTER TABLE hr_insurance_claims
  ADD CONSTRAINT fk_hr_insurance_claims_decider_membership
  FOREIGN KEY (org_id, decided_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_travel_visit_logs
  DROP CONSTRAINT IF EXISTS fk_hr_travel_visit_logs_user_membership;
--> statement-breakpoint

ALTER TABLE hr_travel_visit_logs
  ADD CONSTRAINT fk_hr_travel_visit_logs_user_membership
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL
  NOT VALID;
