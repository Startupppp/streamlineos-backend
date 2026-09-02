-- 0947_ar02_build_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build_events.ticket_comments DROP CONSTRAINT IF EXISTS "fk_ticket_comments_org_ticket";
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log DROP CONSTRAINT IF EXISTS "fk_ticket_activity_log_org_ticket";
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_ticket";
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_sprint";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "fk_workflow_transitions_org_project";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "fk_workflow_transitions_org_to_status";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "fk_workflow_transitions_org_from_status";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT IF EXISTS "fk_work_item_relations_org_item";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT IF EXISTS "fk_work_item_relations_org_related";
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries DROP CONSTRAINT IF EXISTS "fk_webhook_deliveries_org_webhook";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_sprint";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_project";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_module";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_org_cycle";
--> statement-breakpoint
ALTER TABLE build.ticket_watchers DROP CONSTRAINT IF EXISTS "fk_ticket_watchers_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_related_links DROP CONSTRAINT IF EXISTS "fk_ticket_related_links_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT IF EXISTS "fk_ticket_label_mappings_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT IF EXISTS "fk_ticket_label_mappings_org_label";
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values DROP CONSTRAINT IF EXISTS "fk_ticket_cfield_values_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values DROP CONSTRAINT IF EXISTS "fk_ticket_cfield_values_org_def";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions DROP CONSTRAINT IF EXISTS "fk_ticket_comment_reactions_org_comment";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions DROP CONSTRAINT IF EXISTS "fk_ticket_comment_mentions_org_comment";
