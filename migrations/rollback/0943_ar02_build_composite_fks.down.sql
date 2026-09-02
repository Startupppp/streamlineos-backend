-- 0943_ar02_build_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT IF EXISTS "fk_git_ticket_links_org_ticket";
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT IF EXISTS "fk_git_ticket_links_org_connection";
--> statement-breakpoint
ALTER TABLE build.git_connections DROP CONSTRAINT IF EXISTS "fk_git_connections_org_project";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "fk_form_submissions_org_ticket";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "fk_form_submissions_org_project";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "fk_form_submissions_org_form";
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_project";
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_product";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_org_ticket";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_org_widget";
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments DROP CONSTRAINT IF EXISTS "fk_feedbucket_attachments_org_submission";
--> statement-breakpoint
ALTER TABLE build.feedback_votes DROP CONSTRAINT IF EXISTS "fk_feedback_votes_org_post";
--> statement-breakpoint
ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS "fk_feedback_posts_org_roadmap";
--> statement-breakpoint
ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS "fk_feedback_posts_org_dup";
--> statement-breakpoint
ALTER TABLE build.cycles DROP CONSTRAINT IF EXISTS "fk_cycles_org_project";
--> statement-breakpoint
ALTER TABLE build.comment_drafts DROP CONSTRAINT IF EXISTS "fk_comment_drafts_org_ticket";
--> statement-breakpoint
ALTER TABLE build.changelog_entries DROP CONSTRAINT IF EXISTS "fk_changelog_entries_org_roadmap";
--> statement-breakpoint
ALTER TABLE build.change_requests DROP CONSTRAINT IF EXISTS "fk_change_requests_org_project";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "fk_bugs_org_ticket";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "fk_bugs_org_test_case";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "fk_bugs_org_project";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "fk_bugs_org_fixed_release";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "fk_bugs_org_affected_release";
