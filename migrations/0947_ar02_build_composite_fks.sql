-- AR-02: composite tenant FKs — ticket_comment_mentions..workflow_transitions, build_events.*
-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.
-- CRM and Inventory are excluded from this migration by scope.

SET lock_timeout = DEFAULT;

ALTER TABLE build.ticket_comment_mentions
  ADD CONSTRAINT fk_ticket_comment_mentions_org_comment
  FOREIGN KEY (org_id, comment_id)
  REFERENCES build_events.ticket_comments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_comment_mentions VALIDATE CONSTRAINT fk_ticket_comment_mentions_org_comment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions
  ADD CONSTRAINT fk_ticket_comment_reactions_org_comment
  FOREIGN KEY (org_id, comment_id)
  REFERENCES build_events.ticket_comments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_comment_reactions VALIDATE CONSTRAINT fk_ticket_comment_reactions_org_comment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values
  ADD CONSTRAINT fk_ticket_cfield_values_org_def
  FOREIGN KEY (org_id, field_definition_id)
  REFERENCES custom_field_definitions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_custom_field_values VALIDATE CONSTRAINT fk_ticket_cfield_values_org_def;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values
  ADD CONSTRAINT fk_ticket_cfield_values_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_custom_field_values VALIDATE CONSTRAINT fk_ticket_cfield_values_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT fk_ticket_label_mappings_org_label
  FOREIGN KEY (org_id, label_id)
  REFERENCES build.ticket_labels (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_label_mappings VALIDATE CONSTRAINT fk_ticket_label_mappings_org_label;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT fk_ticket_label_mappings_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_label_mappings VALIDATE CONSTRAINT fk_ticket_label_mappings_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_related_links
  ADD CONSTRAINT fk_ticket_related_links_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_related_links VALIDATE CONSTRAINT fk_ticket_related_links_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_watchers
  ADD CONSTRAINT fk_ticket_watchers_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_watchers VALIDATE CONSTRAINT fk_ticket_watchers_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_cycle
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES build.cycles (org_id, id)
  ON DELETE SET NULL (cycle_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_org_cycle;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_module
  FOREIGN KEY (org_id, module_id)
  REFERENCES build.modules (org_id, id)
  ON DELETE SET NULL (module_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_org_module;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_org_sprint
  FOREIGN KEY (org_id, sprint_id)
  REFERENCES build.sprints (org_id, id)
  ON DELETE SET NULL (sprint_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_org_sprint;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries
  ADD CONSTRAINT fk_webhook_deliveries_org_webhook
  FOREIGN KEY (org_id, webhook_id)
  REFERENCES build.project_webhooks (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.webhook_deliveries VALIDATE CONSTRAINT fk_webhook_deliveries_org_webhook;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.work_item_relations
  ADD CONSTRAINT fk_work_item_relations_org_related
  FOREIGN KEY (org_id, related_work_item_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.work_item_relations VALIDATE CONSTRAINT fk_work_item_relations_org_related;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.work_item_relations
  ADD CONSTRAINT fk_work_item_relations_org_item
  FOREIGN KEY (org_id, work_item_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.work_item_relations VALIDATE CONSTRAINT fk_work_item_relations_org_item;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT fk_workflow_transitions_org_from_status
  FOREIGN KEY (org_id, from_status_id)
  REFERENCES build.project_statuses (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.workflow_transitions VALIDATE CONSTRAINT fk_workflow_transitions_org_from_status;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT fk_workflow_transitions_org_to_status
  FOREIGN KEY (org_id, to_status_id)
  REFERENCES build.project_statuses (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.workflow_transitions VALIDATE CONSTRAINT fk_workflow_transitions_org_to_status;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT fk_workflow_transitions_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.workflow_transitions VALIDATE CONSTRAINT fk_workflow_transitions_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT fk_sprint_scope_events_org_sprint
  FOREIGN KEY (org_id, sprint_id)
  REFERENCES build.sprints (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build_events.sprint_scope_events VALIDATE CONSTRAINT fk_sprint_scope_events_org_sprint;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT fk_sprint_scope_events_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build_events.sprint_scope_events VALIDATE CONSTRAINT fk_sprint_scope_events_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log
  ADD CONSTRAINT fk_ticket_activity_log_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build_events.ticket_activity_log VALIDATE CONSTRAINT fk_ticket_activity_log_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build_events.ticket_comments
  ADD CONSTRAINT fk_ticket_comments_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build_events.ticket_comments VALIDATE CONSTRAINT fk_ticket_comments_org_ticket;
SET lock_timeout = DEFAULT;
