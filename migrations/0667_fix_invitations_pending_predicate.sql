SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS uniq_invitations_org_email_pending;
--> statement-breakpoint
CREATE UNIQUE INDEX uniq_invitations_org_email_pending ON invitations (org_id, email) WHERE status = 'PENDING';
