-- L68: Wave L68-A — Chat attribution contraction (DROP legacy columns).
-- Applied AFTER code cutover stops writing to updated_by / created_by.
-- DROP COLUMN cascades to FK and NOT-NULL constraints automatically (Postgres §ALTER TABLE).
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE chat_org_settings DROP COLUMN IF EXISTS updated_by;
--> statement-breakpoint
ALTER TABLE chat_channel_invite_links DROP COLUMN IF EXISTS created_by;
