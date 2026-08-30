-- 0648_build_actor_membership_expand
-- Expand-only: adds membership-identity columns alongside legacy user-id columns in the build schema.
SET lock_timeout = '5s';

ALTER TABLE build.project_members ADD COLUMN IF NOT EXISTS membership_id integer;
--> statement-breakpoint
UPDATE build.project_members t
  SET membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.user_id
    AND t.membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE build.project_members ADD CONSTRAINT fk_project_members_member_actor
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_members VALIDATE CONSTRAINT fk_project_members_member_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_members_org_member_membership ON build.project_members (org_id, membership_id);
--> statement-breakpoint

ALTER TABLE build.tickets ADD COLUMN IF NOT EXISTS assignee_membership_id integer;
--> statement-breakpoint
UPDATE build.tickets t
  SET assignee_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.assignee_id
    AND t.assignee_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE build.tickets ADD CONSTRAINT fk_tickets_assignee_actor
  FOREIGN KEY (org_id, assignee_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_assignee_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_org_assignee_membership ON build.tickets (org_id, assignee_membership_id);
--> statement-breakpoint

ALTER TABLE build.tickets ADD COLUMN IF NOT EXISTS reporter_membership_id integer;
--> statement-breakpoint
UPDATE build.tickets t
  SET reporter_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.reporter_id
    AND t.reporter_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE build.tickets ADD CONSTRAINT fk_tickets_reporter_actor
  FOREIGN KEY (org_id, reporter_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_reporter_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_org_reporter_membership ON build.tickets (org_id, reporter_membership_id);
--> statement-breakpoint

ALTER TABLE build.ticket_assignees ADD COLUMN IF NOT EXISTS membership_id integer;
--> statement-breakpoint
UPDATE build.ticket_assignees t
  SET membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.user_id
    AND t.membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees ADD CONSTRAINT fk_ticket_assignees_member_actor
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees VALIDATE CONSTRAINT fk_ticket_assignees_member_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ticket_assignees_org_member_membership ON build.ticket_assignees (org_id, membership_id);
--> statement-breakpoint

ALTER TABLE build.project_approvals ADD COLUMN IF NOT EXISTS approver_membership_id integer;
--> statement-breakpoint
UPDATE build.project_approvals t
  SET approver_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approver_id
    AND t.approver_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE build.project_approvals ADD CONSTRAINT fk_project_approvals_approver_actor
  FOREIGN KEY (org_id, approver_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_approvals VALIDATE CONSTRAINT fk_project_approvals_approver_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_approvals_org_approver_membership ON build.project_approvals (org_id, approver_membership_id);
