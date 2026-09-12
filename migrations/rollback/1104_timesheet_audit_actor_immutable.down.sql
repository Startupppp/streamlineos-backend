-- Reverses 1104 by re-adding the composite actor foreign key in the column-list
-- form the database carried (a bare SET NULL would null org_id too and abort
-- the parent DELETE — see 0662a). NOT VALID and never validated: rows whose
-- actor has since departed keep their pointer, and validating would refuse
-- them. Re-adding it also re-opens the defect 1104 closed — the next departure
-- rewrites that member's audit rows again.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "timesheet_audit_events"
  ADD CONSTRAINT "fk_timesheet_audit_actor_membership"
  FOREIGN KEY ("org_id", "actor_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("actor_membership_id") NOT VALID;
