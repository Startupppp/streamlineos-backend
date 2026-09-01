-- AR-02: composite tenant FKs — bugs, change_requests, changelog_entries, comment_drafts, cycles, feedback, feedbucket, form_submissions, git
-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.
-- CRM and Inventory are excluded from this migration by scope.

SET lock_timeout = DEFAULT;

ALTER TABLE build.bugs
  ADD CONSTRAINT fk_bugs_org_affected_release
  FOREIGN KEY (org_id, affected_release_id)
  REFERENCES build.project_releases (org_id, id)
  ON DELETE SET NULL (affected_release_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.bugs VALIDATE CONSTRAINT fk_bugs_org_affected_release;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT fk_bugs_org_fixed_release
  FOREIGN KEY (org_id, fixed_release_id)
  REFERENCES build.project_releases (org_id, id)
  ON DELETE SET NULL (fixed_release_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.bugs VALIDATE CONSTRAINT fk_bugs_org_fixed_release;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT fk_bugs_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.bugs VALIDATE CONSTRAINT fk_bugs_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT fk_bugs_org_test_case
  FOREIGN KEY (org_id, linked_test_case_id)
  REFERENCES build.test_cases (org_id, id)
  ON DELETE SET NULL (linked_test_case_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.bugs VALIDATE CONSTRAINT fk_bugs_org_test_case;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT fk_bugs_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.bugs VALIDATE CONSTRAINT fk_bugs_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.change_requests
  ADD CONSTRAINT fk_change_requests_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.change_requests VALIDATE CONSTRAINT fk_change_requests_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.changelog_entries
  ADD CONSTRAINT fk_changelog_entries_org_roadmap
  FOREIGN KEY (org_id, linked_roadmap_item_id)
  REFERENCES build.roadmap_items (org_id, id)
  ON DELETE SET NULL (linked_roadmap_item_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.changelog_entries VALIDATE CONSTRAINT fk_changelog_entries_org_roadmap;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.comment_drafts
  ADD CONSTRAINT fk_comment_drafts_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.comment_drafts VALIDATE CONSTRAINT fk_comment_drafts_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.cycles
  ADD CONSTRAINT fk_cycles_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.cycles VALIDATE CONSTRAINT fk_cycles_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT fk_feedback_posts_org_dup
  FOREIGN KEY (org_id, duplicate_of_id)
  REFERENCES build.feedback_posts (org_id, id)
  ON DELETE SET NULL (duplicate_of_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedback_posts VALIDATE CONSTRAINT fk_feedback_posts_org_dup;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT fk_feedback_posts_org_roadmap
  FOREIGN KEY (org_id, linked_roadmap_item_id)
  REFERENCES build.roadmap_items (org_id, id)
  ON DELETE SET NULL (linked_roadmap_item_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedback_posts VALIDATE CONSTRAINT fk_feedback_posts_org_roadmap;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedback_votes
  ADD CONSTRAINT fk_feedback_votes_org_post
  FOREIGN KEY (org_id, feedback_post_id)
  REFERENCES build.feedback_posts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedback_votes VALIDATE CONSTRAINT fk_feedback_votes_org_post;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments
  ADD CONSTRAINT fk_feedbucket_attachments_org_submission
  FOREIGN KEY (org_id, submission_id)
  REFERENCES build.feedbucket_submissions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedbucket_attachments VALIDATE CONSTRAINT fk_feedbucket_attachments_org_submission;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT fk_feedbucket_submissions_org_widget
  FOREIGN KEY (org_id, widget_id)
  REFERENCES build.feedbucket_widgets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedbucket_submissions VALIDATE CONSTRAINT fk_feedbucket_submissions_org_widget;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT fk_feedbucket_submissions_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedbucket_submissions VALIDATE CONSTRAINT fk_feedbucket_submissions_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets
  ADD CONSTRAINT fk_feedbucket_widgets_org_product
  FOREIGN KEY (org_id, managed_product_id)
  REFERENCES build.managed_products (org_id, id)
  ON DELETE SET NULL (managed_product_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedbucket_widgets VALIDATE CONSTRAINT fk_feedbucket_widgets_org_product;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets
  ADD CONSTRAINT fk_feedbucket_widgets_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.feedbucket_widgets VALIDATE CONSTRAINT fk_feedbucket_widgets_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT fk_form_submissions_org_form
  FOREIGN KEY (org_id, form_id)
  REFERENCES build.project_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.form_submissions VALIDATE CONSTRAINT fk_form_submissions_org_form;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT fk_form_submissions_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.form_submissions VALIDATE CONSTRAINT fk_form_submissions_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT fk_form_submissions_org_ticket
  FOREIGN KEY (org_id, converted_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (converted_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.form_submissions VALIDATE CONSTRAINT fk_form_submissions_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.git_connections
  ADD CONSTRAINT fk_git_connections_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.git_connections VALIDATE CONSTRAINT fk_git_connections_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT fk_git_ticket_links_org_connection
  FOREIGN KEY (org_id, connection_id)
  REFERENCES build.git_connections (org_id, id)
  ON DELETE SET NULL (connection_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.git_ticket_links VALIDATE CONSTRAINT fk_git_ticket_links_org_connection;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT fk_git_ticket_links_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.git_ticket_links VALIDATE CONSTRAINT fk_git_ticket_links_org_ticket;
SET lock_timeout = DEFAULT;
