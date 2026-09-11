-- AR-02: composite tenant FKs — incident_updates, intake_items, managed_product_releases, meeting_*, modules, okr_*, pages
-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.
-- CRM and Inventory are excluded from this migration by scope.

SET lock_timeout = DEFAULT;

ALTER TABLE build.incident_updates
  ADD CONSTRAINT fk_incident_updates_org_incident
  FOREIGN KEY (org_id, incident_id)
  REFERENCES build.project_incidents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.incident_updates VALIDATE CONSTRAINT fk_incident_updates_org_incident;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT fk_intake_items_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.intake_items VALIDATE CONSTRAINT fk_intake_items_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT fk_intake_items_org_ticket
  FOREIGN KEY (org_id, linked_work_item_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_work_item_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.intake_items VALIDATE CONSTRAINT fk_intake_items_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.managed_product_releases
  ADD CONSTRAINT fk_managed_product_releases_org_product
  FOREIGN KEY (org_id, managed_product_id)
  REFERENCES build.managed_products (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.managed_product_releases VALIDATE CONSTRAINT fk_managed_product_releases_org_product;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT fk_meeting_action_items_org_meeting
  FOREIGN KEY (org_id, meeting_id)
  REFERENCES build.project_meetings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.meeting_action_items VALIDATE CONSTRAINT fk_meeting_action_items_org_meeting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT fk_meeting_action_items_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.meeting_action_items VALIDATE CONSTRAINT fk_meeting_action_items_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT fk_meeting_action_items_org_ticket
  FOREIGN KEY (org_id, converted_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (converted_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.meeting_action_items VALIDATE CONSTRAINT fk_meeting_action_items_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.meeting_attendees
  ADD CONSTRAINT fk_meeting_attendees_org_meeting
  FOREIGN KEY (org_id, meeting_id)
  REFERENCES build.project_meetings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.meeting_attendees VALIDATE CONSTRAINT fk_meeting_attendees_org_meeting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries
  ADD CONSTRAINT fk_meeting_standup_entries_org_meeting
  FOREIGN KEY (org_id, meeting_id)
  REFERENCES build.project_meetings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.meeting_standup_entries VALIDATE CONSTRAINT fk_meeting_standup_entries_org_meeting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.modules
  ADD CONSTRAINT fk_modules_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.modules VALIDATE CONSTRAINT fk_modules_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_goals
  ADD CONSTRAINT fk_okr_goals_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_goals VALIDATE CONSTRAINT fk_okr_goals_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_key_results
  ADD CONSTRAINT fk_okr_key_results_org_goal
  FOREIGN KEY (org_id, goal_id)
  REFERENCES build.okr_goals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_key_results VALIDATE CONSTRAINT fk_okr_key_results_org_goal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT fk_okr_links_org_goal
  FOREIGN KEY (org_id, goal_id)
  REFERENCES build.okr_goals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_links VALIDATE CONSTRAINT fk_okr_links_org_goal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT fk_okr_links_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_links VALIDATE CONSTRAINT fk_okr_links_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT fk_okr_links_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_links VALIDATE CONSTRAINT fk_okr_links_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT fk_okr_updates_org_goal
  FOREIGN KEY (org_id, goal_id)
  REFERENCES build.okr_goals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_updates VALIDATE CONSTRAINT fk_okr_updates_org_goal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT fk_okr_updates_org_kr
  FOREIGN KEY (org_id, key_result_id)
  REFERENCES build.okr_key_results (org_id, id)
  ON DELETE SET NULL (key_result_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.okr_updates VALIDATE CONSTRAINT fk_okr_updates_org_kr;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.pages
  ADD CONSTRAINT fk_pages_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.pages VALIDATE CONSTRAINT fk_pages_org_project;
SET lock_timeout = DEFAULT;
