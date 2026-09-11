-- 0944_ar02_build_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.pages DROP CONSTRAINT IF EXISTS "fk_pages_org_project";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT IF EXISTS "fk_okr_updates_org_kr";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT IF EXISTS "fk_okr_updates_org_goal";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "fk_okr_links_org_ticket";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "fk_okr_links_org_project";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "fk_okr_links_org_goal";
--> statement-breakpoint
ALTER TABLE build.okr_key_results DROP CONSTRAINT IF EXISTS "fk_okr_key_results_org_goal";
--> statement-breakpoint
ALTER TABLE build.okr_goals DROP CONSTRAINT IF EXISTS "fk_okr_goals_org_project";
--> statement-breakpoint
ALTER TABLE build.modules DROP CONSTRAINT IF EXISTS "fk_modules_org_project";
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries DROP CONSTRAINT IF EXISTS "fk_meeting_standup_entries_org_meeting";
--> statement-breakpoint
ALTER TABLE build.meeting_attendees DROP CONSTRAINT IF EXISTS "fk_meeting_attendees_org_meeting";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "fk_meeting_action_items_org_ticket";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "fk_meeting_action_items_org_project";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "fk_meeting_action_items_org_meeting";
--> statement-breakpoint
ALTER TABLE build.managed_product_releases DROP CONSTRAINT IF EXISTS "fk_managed_product_releases_org_product";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT IF EXISTS "fk_intake_items_org_ticket";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT IF EXISTS "fk_intake_items_org_project";
--> statement-breakpoint
ALTER TABLE build.incident_updates DROP CONSTRAINT IF EXISTS "fk_incident_updates_org_incident";
