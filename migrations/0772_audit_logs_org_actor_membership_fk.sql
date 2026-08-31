SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE audit_logs
SET actor_membership_id = NULL
WHERE actor_membership_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.id = audit_logs.actor_membership_id
      AND om.org_id = audit_logs.org_id
  );
--> statement-breakpoint

ALTER TABLE audit_logs
  ADD CONSTRAINT fk_audit_logs_org_actor_membership
  FOREIGN KEY (org_id, actor_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL (actor_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE audit_logs VALIDATE CONSTRAINT fk_audit_logs_org_actor_membership;
