SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "organization_setup_invitation_receipts";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_invitations_org_id_setup_receipts";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_outbox_events_org_event_id";
