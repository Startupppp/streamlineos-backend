-- 0938_ar02_build_self_ref_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build_events.ticket_comments DROP CONSTRAINT IF EXISTS "fk_ticket_comments_org_parent";
--> statement-breakpoint
ALTER TABLE build.pages DROP CONSTRAINT IF EXISTS "fk_pages_org_parent";
--> statement-breakpoint
ALTER TABLE build.okr_goals DROP CONSTRAINT IF EXISTS "fk_okr_goals_org_parent";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_recurrence_parent";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_parent";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_epic";
