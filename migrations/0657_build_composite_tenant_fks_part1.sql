-- =============================================================================
-- 0657 — Composite tenant foreign keys: build, part 1
-- =============================================================================
-- Build (projects, tickets, sprints, QA) — part 1 of 2.
--
-- 56 composite tenant foreign keys on build-schema tables.
-- Requires 0656, which authors the unique keys these reference.
--
-- Series 0656-0664. Part of one change: 458 composite tenant foreign keys and
-- the 165 unique keys they reference existed only on the shared Neon branch,
-- created by hand and authored by no migration. backend/CLAUDE.md §3 requires
-- them and says application predicates and RLS do not replace them, so on a
-- database rebuilt from migrations/ nothing stopped a child row referencing a
-- parent in another organisation.
--
-- Shape rules, all of them load-bearing:
--
--   * Every definition is taken verbatim from pg_get_constraintdef, so the
--     ON DELETE clauses that nine of them carry survive. The only edits are
--     mechanical: a trailing " NOT VALID" is stripped from the four that are
--     live-but-unvalidated (we append our own), and the REFERENCES target is
--     schema-qualified — see the next point.
--
--   * Every table name is schema-qualified in all three positions: the
--     to_regclass probe, the ALTER TABLE, and the REFERENCES target. 123 of
--     these constraints are outside public (120 build, 3 build_events), and
--     to_regclass('public.x') on a build table returns NULL — the guard would
--     conclude the table does not exist, skip, and never create the constraint
--     on a fresh build. That is the guard's protection inverted, producing
--     exactly the defect this series exists to fix. The same trap bites the
--     REFERENCES clause from the other side: this database's search_path is
--     '"$user", public, build_events, app', so pg_get_constraintdef renders
--     build_events.ticket_comments as a bare "ticket_comments", which resolves
--     to the wrong table (or to nothing) under any other search_path.
--
--   * ADD CONSTRAINT ... NOT VALID first, VALIDATE CONSTRAINT as a separate
--     statement. A one-step ADD takes ACCESS EXCLUSIVE on BOTH tables while it
--     installs the triggers, so it stalls every write to both behind any long
--     read.
--
--   * Both halves are guarded on pg_constraint via to_regclass — never
--     ::regclass, which throws on a missing table. All of these already exist
--     on the database this was written against, so each file must be a no-op
--     there and the creating statement anywhere else.
--
--   * lock_timeout so a blocked ALTER fails fast instead of queueing and
--     blocking the table behind it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.bugs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_affected_release_id_org'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_affected_release_id_org" FOREIGN KEY (org_id, affected_release_id) REFERENCES "build"."project_releases"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_affected_release_id_org'
             AND conrelid = to_regclass('build.bugs') AND NOT convalidated) THEN
    ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_affected_release_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.bugs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_linked_test_case_id_org'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_linked_test_case_id_org" FOREIGN KEY (org_id, linked_test_case_id) REFERENCES "build"."test_cases"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_linked_test_case_id_org'
             AND conrelid = to_regclass('build.bugs') AND NOT convalidated) THEN
    ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_linked_test_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.bugs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_linked_ticket_id_org'
             AND conrelid = to_regclass('build.bugs') AND NOT convalidated) THEN
    ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.bugs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_project_id_org'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_project_id_org'
             AND conrelid = to_regclass('build.bugs') AND NOT convalidated) THEN
    ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.change_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_change_requests_project_id_org'
                     AND conrelid = to_regclass('build.change_requests')) THEN
    ALTER TABLE "build"."change_requests" ADD CONSTRAINT "fk_change_requests_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_change_requests_project_id_org'
             AND conrelid = to_regclass('build.change_requests') AND NOT convalidated) THEN
    ALTER TABLE "build"."change_requests" VALIDATE CONSTRAINT "fk_change_requests_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.changelog_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_changelog_entries_linked_roadmap_item_id_org'
                     AND conrelid = to_regclass('build.changelog_entries')) THEN
    ALTER TABLE "build"."changelog_entries" ADD CONSTRAINT "fk_changelog_entries_linked_roadmap_item_id_org" FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES "build"."roadmap_items"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_changelog_entries_linked_roadmap_item_id_org'
             AND conrelid = to_regclass('build.changelog_entries') AND NOT convalidated) THEN
    ALTER TABLE "build"."changelog_entries" VALIDATE CONSTRAINT "fk_changelog_entries_linked_roadmap_item_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.comment_drafts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_drafts_ticket_id_org'
                     AND conrelid = to_regclass('build.comment_drafts')) THEN
    ALTER TABLE "build"."comment_drafts" ADD CONSTRAINT "fk_comment_drafts_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_comment_drafts_ticket_id_org'
             AND conrelid = to_regclass('build.comment_drafts') AND NOT convalidated) THEN
    ALTER TABLE "build"."comment_drafts" VALIDATE CONSTRAINT "fk_comment_drafts_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cycles_project_id_org'
                     AND conrelid = to_regclass('build.cycles')) THEN
    ALTER TABLE "build"."cycles" ADD CONSTRAINT "fk_cycles_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cycles_project_id_org'
             AND conrelid = to_regclass('build.cycles') AND NOT convalidated) THEN
    ALTER TABLE "build"."cycles" VALIDATE CONSTRAINT "fk_cycles_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedback_posts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_linked_roadmap_item_id_org'
                     AND conrelid = to_regclass('build.feedback_posts')) THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_linked_roadmap_item_id_org" FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES "build"."roadmap_items"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_linked_roadmap_item_id_org'
             AND conrelid = to_regclass('build.feedback_posts') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_linked_roadmap_item_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedback_votes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_votes_feedback_post_id_org'
                     AND conrelid = to_regclass('build.feedback_votes')) THEN
    ALTER TABLE "build"."feedback_votes" ADD CONSTRAINT "fk_feedback_votes_feedback_post_id_org" FOREIGN KEY (org_id, feedback_post_id) REFERENCES "build"."feedback_posts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_votes_feedback_post_id_org'
             AND conrelid = to_regclass('build.feedback_votes') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedback_votes" VALIDATE CONSTRAINT "fk_feedback_votes_feedback_post_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_attachments_submission_id_org'
                     AND conrelid = to_regclass('build.feedbucket_attachments')) THEN
    ALTER TABLE "build"."feedbucket_attachments" ADD CONSTRAINT "fk_feedbucket_attachments_submission_id_org" FOREIGN KEY (org_id, submission_id) REFERENCES "build"."feedbucket_submissions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_attachments_submission_id_org'
             AND conrelid = to_regclass('build.feedbucket_attachments') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_attachments" VALIDATE CONSTRAINT "fk_feedbucket_attachments_submission_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_linked_ticket_id_org'
             AND conrelid = to_regclass('build.feedbucket_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_widget_id_org'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_widget_id_org" FOREIGN KEY (org_id, widget_id) REFERENCES "build"."feedbucket_widgets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_widget_id_org'
             AND conrelid = to_regclass('build.feedbucket_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_widget_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_widgets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_widgets_project_id_org'
                     AND conrelid = to_regclass('build.feedbucket_widgets')) THEN
    ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT "fk_feedbucket_widgets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_widgets_project_id_org'
             AND conrelid = to_regclass('build.feedbucket_widgets') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.form_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_converted_ticket_id_org'
                     AND conrelid = to_regclass('build.form_submissions')) THEN
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_converted_ticket_id_org" FOREIGN KEY (org_id, converted_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_converted_ticket_id_org'
             AND conrelid = to_regclass('build.form_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."form_submissions" VALIDATE CONSTRAINT "fk_form_submissions_converted_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.form_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_form_id_org'
                     AND conrelid = to_regclass('build.form_submissions')) THEN
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_form_id_org" FOREIGN KEY (org_id, form_id) REFERENCES "build"."project_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_form_id_org'
             AND conrelid = to_regclass('build.form_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."form_submissions" VALIDATE CONSTRAINT "fk_form_submissions_form_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.form_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_project_id_org'
                     AND conrelid = to_regclass('build.form_submissions')) THEN
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_form_submissions_project_id_org'
             AND conrelid = to_regclass('build.form_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."form_submissions" VALIDATE CONSTRAINT "fk_form_submissions_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.git_connections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_connections_project_id_org'
                     AND conrelid = to_regclass('build.git_connections')) THEN
    ALTER TABLE "build"."git_connections" ADD CONSTRAINT "fk_git_connections_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_connections_project_id_org'
             AND conrelid = to_regclass('build.git_connections') AND NOT convalidated) THEN
    ALTER TABLE "build"."git_connections" VALIDATE CONSTRAINT "fk_git_connections_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.git_ticket_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_ticket_links_connection_id_org'
                     AND conrelid = to_regclass('build.git_ticket_links')) THEN
    ALTER TABLE "build"."git_ticket_links" ADD CONSTRAINT "fk_git_ticket_links_connection_id_org" FOREIGN KEY (org_id, connection_id) REFERENCES "build"."git_connections"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_ticket_links_connection_id_org'
             AND conrelid = to_regclass('build.git_ticket_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."git_ticket_links" VALIDATE CONSTRAINT "fk_git_ticket_links_connection_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.git_ticket_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_ticket_links_ticket_id_org'
                     AND conrelid = to_regclass('build.git_ticket_links')) THEN
    ALTER TABLE "build"."git_ticket_links" ADD CONSTRAINT "fk_git_ticket_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_git_ticket_links_ticket_id_org'
             AND conrelid = to_regclass('build.git_ticket_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."git_ticket_links" VALIDATE CONSTRAINT "fk_git_ticket_links_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.incident_updates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incident_updates_incident_id_org'
                     AND conrelid = to_regclass('build.incident_updates')) THEN
    ALTER TABLE "build"."incident_updates" ADD CONSTRAINT "fk_incident_updates_incident_id_org" FOREIGN KEY (org_id, incident_id) REFERENCES "build"."project_incidents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incident_updates_incident_id_org'
             AND conrelid = to_regclass('build.incident_updates') AND NOT convalidated) THEN
    ALTER TABLE "build"."incident_updates" VALIDATE CONSTRAINT "fk_incident_updates_incident_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.intake_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_intake_items_linked_work_item_id_org'
                     AND conrelid = to_regclass('build.intake_items')) THEN
    ALTER TABLE "build"."intake_items" ADD CONSTRAINT "fk_intake_items_linked_work_item_id_org" FOREIGN KEY (org_id, linked_work_item_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_intake_items_linked_work_item_id_org'
             AND conrelid = to_regclass('build.intake_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."intake_items" VALIDATE CONSTRAINT "fk_intake_items_linked_work_item_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.intake_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_intake_items_project_id_org'
                     AND conrelid = to_regclass('build.intake_items')) THEN
    ALTER TABLE "build"."intake_items" ADD CONSTRAINT "fk_intake_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_intake_items_project_id_org'
             AND conrelid = to_regclass('build.intake_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."intake_items" VALIDATE CONSTRAINT "fk_intake_items_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.meeting_action_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_converted_ticket_id_org'
                     AND conrelid = to_regclass('build.meeting_action_items')) THEN
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_converted_ticket_id_org" FOREIGN KEY (org_id, converted_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_converted_ticket_id_org'
             AND conrelid = to_regclass('build.meeting_action_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."meeting_action_items" VALIDATE CONSTRAINT "fk_meeting_action_items_converted_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.meeting_action_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_meeting_id_org'
                     AND conrelid = to_regclass('build.meeting_action_items')) THEN
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES "build"."project_meetings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_meeting_id_org'
             AND conrelid = to_regclass('build.meeting_action_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."meeting_action_items" VALIDATE CONSTRAINT "fk_meeting_action_items_meeting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.meeting_action_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_project_id_org'
                     AND conrelid = to_regclass('build.meeting_action_items')) THEN
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_action_items_project_id_org'
             AND conrelid = to_regclass('build.meeting_action_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."meeting_action_items" VALIDATE CONSTRAINT "fk_meeting_action_items_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.meeting_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_attendees_meeting_id_org'
                     AND conrelid = to_regclass('build.meeting_attendees')) THEN
    ALTER TABLE "build"."meeting_attendees" ADD CONSTRAINT "fk_meeting_attendees_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES "build"."project_meetings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_attendees_meeting_id_org'
             AND conrelid = to_regclass('build.meeting_attendees') AND NOT convalidated) THEN
    ALTER TABLE "build"."meeting_attendees" VALIDATE CONSTRAINT "fk_meeting_attendees_meeting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.meeting_standup_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_standup_entries_meeting_id_org'
                     AND conrelid = to_regclass('build.meeting_standup_entries')) THEN
    ALTER TABLE "build"."meeting_standup_entries" ADD CONSTRAINT "fk_meeting_standup_entries_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES "build"."project_meetings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_standup_entries_meeting_id_org'
             AND conrelid = to_regclass('build.meeting_standup_entries') AND NOT convalidated) THEN
    ALTER TABLE "build"."meeting_standup_entries" VALIDATE CONSTRAINT "fk_meeting_standup_entries_meeting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.modules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_modules_project_id_org'
                     AND conrelid = to_regclass('build.modules')) THEN
    ALTER TABLE "build"."modules" ADD CONSTRAINT "fk_modules_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_modules_project_id_org'
             AND conrelid = to_regclass('build.modules') AND NOT convalidated) THEN
    ALTER TABLE "build"."modules" VALIDATE CONSTRAINT "fk_modules_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_goals_parent_goal_id_org'
                     AND conrelid = to_regclass('build.okr_goals')) THEN
    ALTER TABLE "build"."okr_goals" ADD CONSTRAINT "fk_okr_goals_parent_goal_id_org" FOREIGN KEY (org_id, parent_goal_id) REFERENCES "build"."okr_goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_goals_parent_goal_id_org'
             AND conrelid = to_regclass('build.okr_goals') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_goals" VALIDATE CONSTRAINT "fk_okr_goals_parent_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_goals_project_id_org'
                     AND conrelid = to_regclass('build.okr_goals')) THEN
    ALTER TABLE "build"."okr_goals" ADD CONSTRAINT "fk_okr_goals_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_goals_project_id_org'
             AND conrelid = to_regclass('build.okr_goals') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_goals" VALIDATE CONSTRAINT "fk_okr_goals_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_key_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_key_results_goal_id_org'
                     AND conrelid = to_regclass('build.okr_key_results')) THEN
    ALTER TABLE "build"."okr_key_results" ADD CONSTRAINT "fk_okr_key_results_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES "build"."okr_goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_key_results_goal_id_org'
             AND conrelid = to_regclass('build.okr_key_results') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_key_results" VALIDATE CONSTRAINT "fk_okr_key_results_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_goal_id_org'
                     AND conrelid = to_regclass('build.okr_links')) THEN
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES "build"."okr_goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_goal_id_org'
             AND conrelid = to_regclass('build.okr_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_links" VALIDATE CONSTRAINT "fk_okr_links_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_project_id_org'
                     AND conrelid = to_regclass('build.okr_links')) THEN
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_project_id_org'
             AND conrelid = to_regclass('build.okr_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_links" VALIDATE CONSTRAINT "fk_okr_links_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_ticket_id_org'
                     AND conrelid = to_regclass('build.okr_links')) THEN
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_links_ticket_id_org'
             AND conrelid = to_regclass('build.okr_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_links" VALIDATE CONSTRAINT "fk_okr_links_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_updates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_updates_goal_id_org'
                     AND conrelid = to_regclass('build.okr_updates')) THEN
    ALTER TABLE "build"."okr_updates" ADD CONSTRAINT "fk_okr_updates_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES "build"."okr_goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_updates_goal_id_org'
             AND conrelid = to_regclass('build.okr_updates') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_updates" VALIDATE CONSTRAINT "fk_okr_updates_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_updates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_updates_key_result_id_org'
                     AND conrelid = to_regclass('build.okr_updates')) THEN
    ALTER TABLE "build"."okr_updates" ADD CONSTRAINT "fk_okr_updates_key_result_id_org" FOREIGN KEY (org_id, key_result_id) REFERENCES "build"."okr_key_results"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_okr_updates_key_result_id_org'
             AND conrelid = to_regclass('build.okr_updates') AND NOT convalidated) THEN
    ALTER TABLE "build"."okr_updates" VALIDATE CONSTRAINT "fk_okr_updates_key_result_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pages_parent_page_id_org'
                     AND conrelid = to_regclass('build.pages')) THEN
    ALTER TABLE "build"."pages" ADD CONSTRAINT "fk_pages_parent_page_id_org" FOREIGN KEY (org_id, parent_page_id) REFERENCES "build"."pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pages_parent_page_id_org'
             AND conrelid = to_regclass('build.pages') AND NOT convalidated) THEN
    ALTER TABLE "build"."pages" VALIDATE CONSTRAINT "fk_pages_parent_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pages_project_id_org'
                     AND conrelid = to_regclass('build.pages')) THEN
    ALTER TABLE "build"."pages" ADD CONSTRAINT "fk_pages_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pages_project_id_org'
             AND conrelid = to_regclass('build.pages') AND NOT convalidated) THEN
    ALTER TABLE "build"."pages" VALIDATE CONSTRAINT "fk_pages_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.pm_workspace_memberships') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pm_workspace_memberships_organization_membership_id_org'
                     AND conrelid = to_regclass('build.pm_workspace_memberships')) THEN
    ALTER TABLE "build"."pm_workspace_memberships" ADD CONSTRAINT "fk_pm_workspace_memberships_organization_membership_id_org" FOREIGN KEY (org_id, organization_membership_id) REFERENCES "public"."organization_members"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pm_workspace_memberships_organization_membership_id_org'
             AND conrelid = to_regclass('build.pm_workspace_memberships') AND NOT convalidated) THEN
    ALTER TABLE "build"."pm_workspace_memberships" VALIDATE CONSTRAINT "fk_pm_workspace_memberships_organization_membership_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.portfolio_projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portfolio_projects_portfolio_id_org'
                     AND conrelid = to_regclass('build.portfolio_projects')) THEN
    ALTER TABLE "build"."portfolio_projects" ADD CONSTRAINT "fk_portfolio_projects_portfolio_id_org" FOREIGN KEY (org_id, portfolio_id) REFERENCES "build"."project_portfolios"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portfolio_projects_portfolio_id_org'
             AND conrelid = to_regclass('build.portfolio_projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."portfolio_projects" VALIDATE CONSTRAINT "fk_portfolio_projects_portfolio_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.portfolio_projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portfolio_projects_project_id_org'
                     AND conrelid = to_regclass('build.portfolio_projects')) THEN
    ALTER TABLE "build"."portfolio_projects" ADD CONSTRAINT "fk_portfolio_projects_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portfolio_projects_project_id_org'
             AND conrelid = to_regclass('build.portfolio_projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."portfolio_projects" VALIDATE CONSTRAINT "fk_portfolio_projects_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.program_projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_program_projects_program_id_org'
                     AND conrelid = to_regclass('build.program_projects')) THEN
    ALTER TABLE "build"."program_projects" ADD CONSTRAINT "fk_program_projects_program_id_org" FOREIGN KEY (org_id, program_id) REFERENCES "build"."project_programs"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_program_projects_program_id_org'
             AND conrelid = to_regclass('build.program_projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."program_projects" VALIDATE CONSTRAINT "fk_program_projects_program_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.program_projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_program_projects_project_id_org'
                     AND conrelid = to_regclass('build.program_projects')) THEN
    ALTER TABLE "build"."program_projects" ADD CONSTRAINT "fk_program_projects_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_program_projects_project_id_org'
             AND conrelid = to_regclass('build.program_projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."program_projects" VALIDATE CONSTRAINT "fk_program_projects_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_approvals_project_id_org'
                     AND conrelid = to_regclass('build.project_approvals')) THEN
    ALTER TABLE "build"."project_approvals" ADD CONSTRAINT "fk_project_approvals_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_approvals_project_id_org'
             AND conrelid = to_regclass('build.project_approvals') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_approvals" VALIDATE CONSTRAINT "fk_project_approvals_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_automations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_automations_project_id_org'
                     AND conrelid = to_regclass('build.project_automations')) THEN
    ALTER TABLE "build"."project_automations" ADD CONSTRAINT "fk_project_automations_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_automations_project_id_org'
             AND conrelid = to_regclass('build.project_automations') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_automations" VALIDATE CONSTRAINT "fk_project_automations_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_daily_snapshots') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_daily_snapshots_project_id_org'
                     AND conrelid = to_regclass('build.project_daily_snapshots')) THEN
    ALTER TABLE "build"."project_daily_snapshots" ADD CONSTRAINT "fk_project_daily_snapshots_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_daily_snapshots_project_id_org'
             AND conrelid = to_regclass('build.project_daily_snapshots') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_daily_snapshots" VALIDATE CONSTRAINT "fk_project_daily_snapshots_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_decisions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_decisions_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.project_decisions')) THEN
    ALTER TABLE "build"."project_decisions" ADD CONSTRAINT "fk_project_decisions_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_decisions_linked_ticket_id_org'
             AND conrelid = to_regclass('build.project_decisions') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_decisions" VALIDATE CONSTRAINT "fk_project_decisions_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_decisions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_decisions_project_id_org'
                     AND conrelid = to_regclass('build.project_decisions')) THEN
    ALTER TABLE "build"."project_decisions" ADD CONSTRAINT "fk_project_decisions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_decisions_project_id_org'
             AND conrelid = to_regclass('build.project_decisions') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_decisions" VALIDATE CONSTRAINT "fk_project_decisions_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_forms_project_id_org'
                     AND conrelid = to_regclass('build.project_forms')) THEN
    ALTER TABLE "build"."project_forms" ADD CONSTRAINT "fk_project_forms_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_forms_project_id_org'
             AND conrelid = to_regclass('build.project_forms') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_forms" VALIDATE CONSTRAINT "fk_project_forms_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_incidents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_incidents_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.project_incidents')) THEN
    ALTER TABLE "build"."project_incidents" ADD CONSTRAINT "fk_project_incidents_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_incidents_linked_ticket_id_org'
             AND conrelid = to_regclass('build.project_incidents') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_incidents" VALIDATE CONSTRAINT "fk_project_incidents_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_incidents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_incidents_project_id_org'
                     AND conrelid = to_regclass('build.project_incidents')) THEN
    ALTER TABLE "build"."project_incidents" ADD CONSTRAINT "fk_project_incidents_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_incidents_project_id_org'
             AND conrelid = to_regclass('build.project_incidents') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_incidents" VALIDATE CONSTRAINT "fk_project_incidents_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_meetings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_meetings_project_id_org'
                     AND conrelid = to_regclass('build.project_meetings')) THEN
    ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_meetings_project_id_org'
             AND conrelid = to_regclass('build.project_meetings') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_meetings" VALIDATE CONSTRAINT "fk_project_meetings_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_meetings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_meetings_sprint_id_org'
                     AND conrelid = to_regclass('build.project_meetings')) THEN
    ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES "build"."sprints"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_meetings_sprint_id_org'
             AND conrelid = to_regclass('build.project_meetings') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_meetings" VALIDATE CONSTRAINT "fk_project_meetings_sprint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_members_project_id_org'
                     AND conrelid = to_regclass('build.project_members')) THEN
    ALTER TABLE "build"."project_members" ADD CONSTRAINT "fk_project_members_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_members_project_id_org'
             AND conrelid = to_regclass('build.project_members') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_members" VALIDATE CONSTRAINT "fk_project_members_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_milestones') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_milestones_project_id_org'
                     AND conrelid = to_regclass('build.project_milestones')) THEN
    ALTER TABLE "build"."project_milestones" ADD CONSTRAINT "fk_project_milestones_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_milestones_project_id_org'
             AND conrelid = to_regclass('build.project_milestones') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_milestones" VALIDATE CONSTRAINT "fk_project_milestones_project_id_org";
  END IF;
END $$;
