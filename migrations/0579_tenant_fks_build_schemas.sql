-- Composite tenant FKs, build and build_events schemas.
--
-- Split by size, not by meaning: the purpose is identical across all four. §3 warns a ~2000-op monolith ECONNRESETs on Neon, and 635 constraints is ~1266 statements.
--
-- backend/CLAUDE.md §3: every tenant edge carries a composite tenant FK, and
-- "applied to the Neon branch" is not migrated. 635 of the 799 composite
-- same-tenant foreign keys on this database were applied by hand and exist in
-- no migration file, so a database rebuilt from migrations/ has no cross-tenant
-- referential integrity at all -- nothing stops a row referencing another
-- organisation's parent. This file authors 123 of them.
--
-- Every constraint is added NOT VALID and validated in a separate statement:
-- one-step ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on BOTH tables
-- while it installs triggers, which on a populated database stalls every write
-- to both behind any long read.
--
-- Both halves are guarded on pg_constraint, because all of these already exist
-- on the database this was written against: the file must be a no-op there
-- while being the creating statement on a fresh build.
--
-- Every probe and every ALTER is SCHEMA-QUALIFIED, deliberately. to_regclass
-- returns NULL rather than throwing for a table in another schema, so an
-- unqualified 'public.x' probe against a build-schema table concludes "table
-- absent, skip" -- no error, no DDL, no trace. A guard whose failure mode is
-- silence is worse than no guard, because it reads as care.
--
-- statement_timeout is cleared: these are heavy catalog DO-blocks and Neon
-- cancels them on a cold build otherwise (§3, cold-DB rule 2).
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  IF to_regclass('build_events.ticket_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_activity_log_ticket_id_org'
                     AND conrelid = to_regclass('build_events.ticket_activity_log')) THEN
    ALTER TABLE "build_events"."ticket_activity_log" ADD CONSTRAINT "fk_ticket_activity_log_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_activity_log_ticket_id_org'
             AND conrelid = to_regclass('build_events.ticket_activity_log') AND NOT convalidated) THEN
    ALTER TABLE "build_events"."ticket_activity_log" VALIDATE CONSTRAINT "fk_ticket_activity_log_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build_events.ticket_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comments_parent_comment_id_org'
                     AND conrelid = to_regclass('build_events.ticket_comments')) THEN
    ALTER TABLE "build_events"."ticket_comments" ADD CONSTRAINT "fk_ticket_comments_parent_comment_id_org" FOREIGN KEY (org_id, parent_comment_id) REFERENCES ticket_comments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comments_parent_comment_id_org'
             AND conrelid = to_regclass('build_events.ticket_comments') AND NOT convalidated) THEN
    ALTER TABLE "build_events"."ticket_comments" VALIDATE CONSTRAINT "fk_ticket_comments_parent_comment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build_events.ticket_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comments_ticket_id_org'
                     AND conrelid = to_regclass('build_events.ticket_comments')) THEN
    ALTER TABLE "build_events"."ticket_comments" ADD CONSTRAINT "fk_ticket_comments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comments_ticket_id_org'
             AND conrelid = to_regclass('build_events.ticket_comments') AND NOT convalidated) THEN
    ALTER TABLE "build_events"."ticket_comments" VALIDATE CONSTRAINT "fk_ticket_comments_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.bugs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bugs_affected_release_id_org'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_affected_release_id_org" FOREIGN KEY (org_id, affected_release_id) REFERENCES build.project_releases(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_linked_test_case_id_org" FOREIGN KEY (org_id, linked_test_case_id) REFERENCES build.test_cases(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "fk_bugs_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."change_requests" ADD CONSTRAINT "fk_change_requests_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."changelog_entries" ADD CONSTRAINT "fk_changelog_entries_linked_roadmap_item_id_org" FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES build.roadmap_items(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."comment_drafts" ADD CONSTRAINT "fk_comment_drafts_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."cycles" ADD CONSTRAINT "fk_cycles_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_crm_contact_party_id'
                     AND conrelid = to_regclass('build.feedback_posts')) THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact_party_id" FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_crm_contact_party_id'
             AND conrelid = to_regclass('build.feedback_posts') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedback_posts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_crm_organization_party_id'
                     AND conrelid = to_regclass('build.feedback_posts')) THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization_party_id" FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_crm_organization_party_id'
             AND conrelid = to_regclass('build.feedback_posts') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_organization_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedback_posts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_posts_linked_roadmap_item_id_org'
                     AND conrelid = to_regclass('build.feedback_posts')) THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_linked_roadmap_item_id_org" FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES build.roadmap_items(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."feedback_votes" ADD CONSTRAINT "fk_feedback_votes_feedback_post_id_org" FOREIGN KEY (org_id, feedback_post_id) REFERENCES build.feedback_posts(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."feedbucket_attachments" ADD CONSTRAINT "fk_feedbucket_attachments_submission_id_org" FOREIGN KEY (org_id, submission_id) REFERENCES build.feedbucket_submissions(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_crm_contact_party_id'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact_party_id" FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_crm_contact_party_id'
             AND conrelid = to_regclass('build.feedbucket_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_crm_organization_party_id'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_organization_party_id" FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_crm_organization_party_id'
             AND conrelid = to_regclass('build.feedbucket_submissions') AND NOT convalidated) THEN
    ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_organization_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedbucket_submissions_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_widget_id_org" FOREIGN KEY (org_id, widget_id) REFERENCES build.feedbucket_widgets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT "fk_feedbucket_widgets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_converted_ticket_id_org" FOREIGN KEY (org_id, converted_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_form_id_org" FOREIGN KEY (org_id, form_id) REFERENCES build.project_forms(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."form_submissions" ADD CONSTRAINT "fk_form_submissions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."git_connections" ADD CONSTRAINT "fk_git_connections_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."git_ticket_links" ADD CONSTRAINT "fk_git_ticket_links_connection_id_org" FOREIGN KEY (org_id, connection_id) REFERENCES build.git_connections(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."git_ticket_links" ADD CONSTRAINT "fk_git_ticket_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."incident_updates" ADD CONSTRAINT "fk_incident_updates_incident_id_org" FOREIGN KEY (org_id, incident_id) REFERENCES build.project_incidents(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."intake_items" ADD CONSTRAINT "fk_intake_items_linked_work_item_id_org" FOREIGN KEY (org_id, linked_work_item_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."intake_items" ADD CONSTRAINT "fk_intake_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_converted_ticket_id_org" FOREIGN KEY (org_id, converted_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."meeting_action_items" ADD CONSTRAINT "fk_meeting_action_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."meeting_attendees" ADD CONSTRAINT "fk_meeting_attendees_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."meeting_standup_entries" ADD CONSTRAINT "fk_meeting_standup_entries_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."modules" ADD CONSTRAINT "fk_modules_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_goals" ADD CONSTRAINT "fk_okr_goals_parent_goal_id_org" FOREIGN KEY (org_id, parent_goal_id) REFERENCES build.okr_goals(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_goals" ADD CONSTRAINT "fk_okr_goals_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_key_results" ADD CONSTRAINT "fk_okr_key_results_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_links" ADD CONSTRAINT "fk_okr_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_updates" ADD CONSTRAINT "fk_okr_updates_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."okr_updates" ADD CONSTRAINT "fk_okr_updates_key_result_id_org" FOREIGN KEY (org_id, key_result_id) REFERENCES build.okr_key_results(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."pages" ADD CONSTRAINT "fk_pages_parent_page_id_org" FOREIGN KEY (org_id, parent_page_id) REFERENCES build.pages(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."pages" ADD CONSTRAINT "fk_pages_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."pm_workspace_memberships" ADD CONSTRAINT "fk_pm_workspace_memberships_organization_membership_id_org" FOREIGN KEY (org_id, organization_membership_id) REFERENCES organization_members(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."portfolio_projects" ADD CONSTRAINT "fk_portfolio_projects_portfolio_id_org" FOREIGN KEY (org_id, portfolio_id) REFERENCES build.project_portfolios(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."portfolio_projects" ADD CONSTRAINT "fk_portfolio_projects_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."program_projects" ADD CONSTRAINT "fk_program_projects_program_id_org" FOREIGN KEY (org_id, program_id) REFERENCES build.project_programs(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."program_projects" ADD CONSTRAINT "fk_program_projects_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_approvals_approver_actor'
                     AND conrelid = to_regclass('build.project_approvals')) THEN
    ALTER TABLE "build"."project_approvals" ADD CONSTRAINT "fk_project_approvals_approver_actor" FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_approvals_approver_actor'
             AND conrelid = to_regclass('build.project_approvals') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_approvals" VALIDATE CONSTRAINT "fk_project_approvals_approver_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_approvals_project_id_org'
                     AND conrelid = to_regclass('build.project_approvals')) THEN
    ALTER TABLE "build"."project_approvals" ADD CONSTRAINT "fk_project_approvals_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_automations" ADD CONSTRAINT "fk_project_automations_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_daily_snapshots" ADD CONSTRAINT "fk_project_daily_snapshots_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_decisions" ADD CONSTRAINT "fk_project_decisions_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_decisions" ADD CONSTRAINT "fk_project_decisions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_forms" ADD CONSTRAINT "fk_project_forms_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_incidents" ADD CONSTRAINT "fk_project_incidents_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_incidents" ADD CONSTRAINT "fk_project_incidents_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_members_member_actor'
                     AND conrelid = to_regclass('build.project_members')) THEN
    ALTER TABLE "build"."project_members" ADD CONSTRAINT "fk_project_members_member_actor" FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_members_member_actor'
             AND conrelid = to_regclass('build.project_members') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_members" VALIDATE CONSTRAINT "fk_project_members_member_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_members_project_id_org'
                     AND conrelid = to_regclass('build.project_members')) THEN
    ALTER TABLE "build"."project_members" ADD CONSTRAINT "fk_project_members_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_milestones" ADD CONSTRAINT "fk_project_milestones_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_milestones_project_id_org'
             AND conrelid = to_regclass('build.project_milestones') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_milestones" VALIDATE CONSTRAINT "fk_project_milestones_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_programs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_programs_portfolio_id_org'
                     AND conrelid = to_regclass('build.project_programs')) THEN
    ALTER TABLE "build"."project_programs" ADD CONSTRAINT "fk_project_programs_portfolio_id_org" FOREIGN KEY (org_id, portfolio_id) REFERENCES build.project_portfolios(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_programs_portfolio_id_org'
             AND conrelid = to_regclass('build.project_programs') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_programs" VALIDATE CONSTRAINT "fk_project_programs_portfolio_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_releases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_releases_project_id_org'
                     AND conrelid = to_regclass('build.project_releases')) THEN
    ALTER TABLE "build"."project_releases" ADD CONSTRAINT "fk_project_releases_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_releases_project_id_org'
             AND conrelid = to_regclass('build.project_releases') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_releases" VALIDATE CONSTRAINT "fk_project_releases_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_risks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_risks_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.project_risks')) THEN
    ALTER TABLE "build"."project_risks" ADD CONSTRAINT "fk_project_risks_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_risks_linked_ticket_id_org'
             AND conrelid = to_regclass('build.project_risks') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_risks" VALIDATE CONSTRAINT "fk_project_risks_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_risks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_risks_project_id_org'
                     AND conrelid = to_regclass('build.project_risks')) THEN
    ALTER TABLE "build"."project_risks" ADD CONSTRAINT "fk_project_risks_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_risks_project_id_org'
             AND conrelid = to_regclass('build.project_risks') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_risks" VALIDATE CONSTRAINT "fk_project_risks_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_statuses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_statuses_project_id_org'
                     AND conrelid = to_regclass('build.project_statuses')) THEN
    ALTER TABLE "build"."project_statuses" ADD CONSTRAINT "fk_project_statuses_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_statuses_project_id_org'
             AND conrelid = to_regclass('build.project_statuses') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_statuses" VALIDATE CONSTRAINT "fk_project_statuses_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_team_assignments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_assignments_project_id_org'
                     AND conrelid = to_regclass('build.project_team_assignments')) THEN
    ALTER TABLE "build"."project_team_assignments" ADD CONSTRAINT "fk_project_team_assignments_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_assignments_project_id_org'
             AND conrelid = to_regclass('build.project_team_assignments') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_team_assignments" VALIDATE CONSTRAINT "fk_project_team_assignments_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_team_assignments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_assignments_team_id_org'
                     AND conrelid = to_regclass('build.project_team_assignments')) THEN
    ALTER TABLE "build"."project_team_assignments" ADD CONSTRAINT "fk_project_team_assignments_team_id_org" FOREIGN KEY (org_id, team_id) REFERENCES build.project_teams(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_assignments_team_id_org'
             AND conrelid = to_regclass('build.project_team_assignments') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_team_assignments" VALIDATE CONSTRAINT "fk_project_team_assignments_team_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_team_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_members_team_id_org'
                     AND conrelid = to_regclass('build.project_team_members')) THEN
    ALTER TABLE "build"."project_team_members" ADD CONSTRAINT "fk_project_team_members_team_id_org" FOREIGN KEY (org_id, team_id) REFERENCES build.project_teams(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_team_members_team_id_org'
             AND conrelid = to_regclass('build.project_team_members') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_team_members" VALIDATE CONSTRAINT "fk_project_team_members_team_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_template_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_template_tickets_template_id_org'
                     AND conrelid = to_regclass('build.project_template_tickets')) THEN
    ALTER TABLE "build"."project_template_tickets" ADD CONSTRAINT "fk_project_template_tickets_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES build.project_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_template_tickets_template_id_org'
             AND conrelid = to_regclass('build.project_template_tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_template_tickets" VALIDATE CONSTRAINT "fk_project_template_tickets_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_views') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_views_project_id_org'
                     AND conrelid = to_regclass('build.project_views')) THEN
    ALTER TABLE "build"."project_views" ADD CONSTRAINT "fk_project_views_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_views_project_id_org'
             AND conrelid = to_regclass('build.project_views') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_views" VALIDATE CONSTRAINT "fk_project_views_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_webhooks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_webhooks_project_id_org'
                     AND conrelid = to_regclass('build.project_webhooks')) THEN
    ALTER TABLE "build"."project_webhooks" ADD CONSTRAINT "fk_project_webhooks_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_webhooks_project_id_org'
             AND conrelid = to_regclass('build.project_webhooks') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_webhooks" VALIDATE CONSTRAINT "fk_project_webhooks_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_whiteboard_shares') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_whiteboard_shares_whiteboard_id_org'
                     AND conrelid = to_regclass('build.project_whiteboard_shares')) THEN
    ALTER TABLE "build"."project_whiteboard_shares" ADD CONSTRAINT "fk_project_whiteboard_shares_whiteboard_id_org" FOREIGN KEY (org_id, whiteboard_id) REFERENCES build.project_whiteboards(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_whiteboard_shares_whiteboard_id_org'
             AND conrelid = to_regclass('build.project_whiteboard_shares') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_whiteboard_shares" VALIDATE CONSTRAINT "fk_project_whiteboard_shares_whiteboard_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_whiteboards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_whiteboards_project_id_org'
                     AND conrelid = to_regclass('build.project_whiteboards')) THEN
    ALTER TABLE "build"."project_whiteboards" ADD CONSTRAINT "fk_project_whiteboards_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_whiteboards_project_id_org'
             AND conrelid = to_regclass('build.project_whiteboards') AND NOT convalidated) THEN
    ALTER TABLE "build"."project_whiteboards" VALIDATE CONSTRAINT "fk_project_whiteboards_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_deal_id_org'
                     AND conrelid = to_regclass('build.projects')) THEN
    ALTER TABLE "build"."projects" ADD CONSTRAINT "fk_projects_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_deal_id_org'
             AND conrelid = to_regclass('build.projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "fk_projects_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_managed_product_id_org'
                     AND conrelid = to_regclass('build.projects')) THEN
    ALTER TABLE "build"."projects" ADD CONSTRAINT "fk_projects_managed_product_id_org" FOREIGN KEY (org_id, managed_product_id) REFERENCES build.managed_products(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_managed_product_id_org'
             AND conrelid = to_regclass('build.projects') AND NOT convalidated) THEN
    ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "fk_projects_managed_product_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.release_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_release_tickets_release_id_org'
                     AND conrelid = to_regclass('build.release_tickets')) THEN
    ALTER TABLE "build"."release_tickets" ADD CONSTRAINT "fk_release_tickets_release_id_org" FOREIGN KEY (org_id, release_id) REFERENCES build.project_releases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_release_tickets_release_id_org'
             AND conrelid = to_regclass('build.release_tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."release_tickets" VALIDATE CONSTRAINT "fk_release_tickets_release_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.release_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_release_tickets_ticket_id_org'
                     AND conrelid = to_regclass('build.release_tickets')) THEN
    ALTER TABLE "build"."release_tickets" ADD CONSTRAINT "fk_release_tickets_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_release_tickets_ticket_id_org'
             AND conrelid = to_regclass('build.release_tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."release_tickets" VALIDATE CONSTRAINT "fk_release_tickets_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.roadmap_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_items_epic_ticket_id_org'
                     AND conrelid = to_regclass('build.roadmap_items')) THEN
    ALTER TABLE "build"."roadmap_items" ADD CONSTRAINT "fk_roadmap_items_epic_ticket_id_org" FOREIGN KEY (org_id, epic_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_items_epic_ticket_id_org'
             AND conrelid = to_regclass('build.roadmap_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."roadmap_items" VALIDATE CONSTRAINT "fk_roadmap_items_epic_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.roadmap_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_items_project_id_org'
                     AND conrelid = to_regclass('build.roadmap_items')) THEN
    ALTER TABLE "build"."roadmap_items" ADD CONSTRAINT "fk_roadmap_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_items_project_id_org'
             AND conrelid = to_regclass('build.roadmap_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."roadmap_items" VALIDATE CONSTRAINT "fk_roadmap_items_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.roadmap_votes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_votes_roadmap_item_id_org'
                     AND conrelid = to_regclass('build.roadmap_votes')) THEN
    ALTER TABLE "build"."roadmap_votes" ADD CONSTRAINT "fk_roadmap_votes_roadmap_item_id_org" FOREIGN KEY (org_id, roadmap_item_id) REFERENCES build.roadmap_items(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roadmap_votes_roadmap_item_id_org'
             AND conrelid = to_regclass('build.roadmap_votes') AND NOT convalidated) THEN
    ALTER TABLE "build"."roadmap_votes" VALIDATE CONSTRAINT "fk_roadmap_votes_roadmap_item_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.sprints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sprints_project_id_org'
                     AND conrelid = to_regclass('build.sprints')) THEN
    ALTER TABLE "build"."sprints" ADD CONSTRAINT "fk_sprints_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sprints_project_id_org'
             AND conrelid = to_regclass('build.sprints') AND NOT convalidated) THEN
    ALTER TABLE "build"."sprints" VALIDATE CONSTRAINT "fk_sprints_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_cases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_linked_ticket_id_org'
                     AND conrelid = to_regclass('build.test_cases')) THEN
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_linked_ticket_id_org'
             AND conrelid = to_regclass('build.test_cases') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_cases" VALIDATE CONSTRAINT "fk_test_cases_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_cases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_project_id_org'
                     AND conrelid = to_regclass('build.test_cases')) THEN
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_project_id_org'
             AND conrelid = to_regclass('build.test_cases') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_cases" VALIDATE CONSTRAINT "fk_test_cases_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_cases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_suite_id_org'
                     AND conrelid = to_regclass('build.test_cases')) THEN
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_suite_id_org" FOREIGN KEY (org_id, suite_id) REFERENCES build.test_suites(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_cases_suite_id_org'
             AND conrelid = to_regclass('build.test_cases') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_cases" VALIDATE CONSTRAINT "fk_test_cases_suite_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_run_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_linked_bug_id_org'
                     AND conrelid = to_regclass('build.test_run_results')) THEN
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_linked_bug_id_org" FOREIGN KEY (org_id, linked_bug_id) REFERENCES build.bugs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_linked_bug_id_org'
             AND conrelid = to_regclass('build.test_run_results') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_run_results" VALIDATE CONSTRAINT "fk_test_run_results_linked_bug_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_run_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_project_id_org'
                     AND conrelid = to_regclass('build.test_run_results')) THEN
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_project_id_org'
             AND conrelid = to_regclass('build.test_run_results') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_run_results" VALIDATE CONSTRAINT "fk_test_run_results_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_run_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_run_id_org'
                     AND conrelid = to_regclass('build.test_run_results')) THEN
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES build.test_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_run_id_org'
             AND conrelid = to_regclass('build.test_run_results') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_run_results" VALIDATE CONSTRAINT "fk_test_run_results_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_run_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_test_case_id_org'
                     AND conrelid = to_regclass('build.test_run_results')) THEN
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_test_case_id_org" FOREIGN KEY (org_id, test_case_id) REFERENCES build.test_cases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_run_results_test_case_id_org'
             AND conrelid = to_regclass('build.test_run_results') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_run_results" VALIDATE CONSTRAINT "fk_test_run_results_test_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_project_id_org'
                     AND conrelid = to_regclass('build.test_runs')) THEN
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_project_id_org'
             AND conrelid = to_regclass('build.test_runs') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_release_id_org'
                     AND conrelid = to_regclass('build.test_runs')) THEN
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_release_id_org" FOREIGN KEY (org_id, release_id) REFERENCES build.project_releases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_release_id_org'
             AND conrelid = to_regclass('build.test_runs') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_release_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_sprint_id_org'
                     AND conrelid = to_regclass('build.test_runs')) THEN
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_runs_sprint_id_org'
             AND conrelid = to_regclass('build.test_runs') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_sprint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_suites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_suites_parent_id_org'
                     AND conrelid = to_regclass('build.test_suites')) THEN
    ALTER TABLE "build"."test_suites" ADD CONSTRAINT "fk_test_suites_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES build.test_suites(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_suites_parent_id_org'
             AND conrelid = to_regclass('build.test_suites') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_suites" VALIDATE CONSTRAINT "fk_test_suites_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_suites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_suites_project_id_org'
                     AND conrelid = to_regclass('build.test_suites')) THEN
    ALTER TABLE "build"."test_suites" ADD CONSTRAINT "fk_test_suites_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_test_suites_project_id_org'
             AND conrelid = to_regclass('build.test_suites') AND NOT convalidated) THEN
    ALTER TABLE "build"."test_suites" VALIDATE CONSTRAINT "fk_test_suites_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_assignees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_assignees_member_actor'
                     AND conrelid = to_regclass('build.ticket_assignees')) THEN
    ALTER TABLE "build"."ticket_assignees" ADD CONSTRAINT "fk_ticket_assignees_member_actor" FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_assignees_member_actor'
             AND conrelid = to_regclass('build.ticket_assignees') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_assignees" VALIDATE CONSTRAINT "fk_ticket_assignees_member_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_assignees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_assignees_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_assignees')) THEN
    ALTER TABLE "build"."ticket_assignees" ADD CONSTRAINT "fk_ticket_assignees_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_assignees_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_assignees') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_assignees" VALIDATE CONSTRAINT "fk_ticket_assignees_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_attachments_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_attachments')) THEN
    ALTER TABLE "build"."ticket_attachments" ADD CONSTRAINT "fk_ticket_attachments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_attachments_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_attachments') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_attachments" VALIDATE CONSTRAINT "fk_ticket_attachments_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_checklist_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_checklist_items_checklist_id_org'
                     AND conrelid = to_regclass('build.ticket_checklist_items')) THEN
    ALTER TABLE "build"."ticket_checklist_items" ADD CONSTRAINT "fk_ticket_checklist_items_checklist_id_org" FOREIGN KEY (org_id, checklist_id) REFERENCES build.ticket_checklists(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_checklist_items_checklist_id_org'
             AND conrelid = to_regclass('build.ticket_checklist_items') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_checklist_items" VALIDATE CONSTRAINT "fk_ticket_checklist_items_checklist_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_checklists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_checklists_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_checklists')) THEN
    ALTER TABLE "build"."ticket_checklists" ADD CONSTRAINT "fk_ticket_checklists_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_checklists_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_checklists') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_checklists" VALIDATE CONSTRAINT "fk_ticket_checklists_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_comment_mentions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comment_mentions_comment_id_org'
                     AND conrelid = to_regclass('build.ticket_comment_mentions')) THEN
    ALTER TABLE "build"."ticket_comment_mentions" ADD CONSTRAINT "fk_ticket_comment_mentions_comment_id_org" FOREIGN KEY (org_id, comment_id) REFERENCES ticket_comments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comment_mentions_comment_id_org'
             AND conrelid = to_regclass('build.ticket_comment_mentions') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_comment_mentions" VALIDATE CONSTRAINT "fk_ticket_comment_mentions_comment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_comment_reactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comment_reactions_comment_id_org'
                     AND conrelid = to_regclass('build.ticket_comment_reactions')) THEN
    ALTER TABLE "build"."ticket_comment_reactions" ADD CONSTRAINT "fk_ticket_comment_reactions_comment_id_org" FOREIGN KEY (org_id, comment_id) REFERENCES ticket_comments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comment_reactions_comment_id_org'
             AND conrelid = to_regclass('build.ticket_comment_reactions') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_comment_reactions" VALIDATE CONSTRAINT "fk_ticket_comment_reactions_comment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_label_mappings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_label_mappings_label_id_org'
                     AND conrelid = to_regclass('build.ticket_label_mappings')) THEN
    ALTER TABLE "build"."ticket_label_mappings" ADD CONSTRAINT "fk_ticket_label_mappings_label_id_org" FOREIGN KEY (org_id, label_id) REFERENCES build.ticket_labels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_label_mappings_label_id_org'
             AND conrelid = to_regclass('build.ticket_label_mappings') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_label_mappings" VALIDATE CONSTRAINT "fk_ticket_label_mappings_label_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_label_mappings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_label_mappings_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_label_mappings')) THEN
    ALTER TABLE "build"."ticket_label_mappings" ADD CONSTRAINT "fk_ticket_label_mappings_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_label_mappings_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_label_mappings') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_label_mappings" VALIDATE CONSTRAINT "fk_ticket_label_mappings_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_related_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_related_links_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_related_links')) THEN
    ALTER TABLE "build"."ticket_related_links" ADD CONSTRAINT "fk_ticket_related_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_related_links_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_related_links') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_related_links" VALIDATE CONSTRAINT "fk_ticket_related_links_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_watchers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_watchers_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_watchers')) THEN
    ALTER TABLE "build"."ticket_watchers" ADD CONSTRAINT "fk_ticket_watchers_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_watchers_ticket_id_org'
             AND conrelid = to_regclass('build.ticket_watchers') AND NOT convalidated) THEN
    ALTER TABLE "build"."ticket_watchers" VALIDATE CONSTRAINT "fk_ticket_watchers_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_assignee_actor'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_assignee_actor" FOREIGN KEY (org_id, assignee_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_assignee_actor'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_assignee_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_id_org" FOREIGN KEY (org_id, customer_id) REFERENCES crm_organizations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_org_party_id'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_org_party_id" FOREIGN KEY (org_id, customer_org_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_org_party_id'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_org_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_party_id'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_party_id" FOREIGN KEY (org_id, customer_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_customer_party_id'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_cycle_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES build.cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_cycle_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_epic_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_epic_id_org" FOREIGN KEY (org_id, epic_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_epic_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_epic_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_module_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_module_id_org" FOREIGN KEY (org_id, module_id) REFERENCES build.modules(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_module_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_module_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_project_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_project_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_reporter_actor'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_reporter_actor" FOREIGN KEY (org_id, reporter_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_reporter_actor'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_reporter_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_sprint_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_sprint_id_org'
             AND conrelid = to_regclass('build.tickets') AND NOT convalidated) THEN
    ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_sprint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.webhook_deliveries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_deliveries_webhook_id_org'
                     AND conrelid = to_regclass('build.webhook_deliveries')) THEN
    ALTER TABLE "build"."webhook_deliveries" ADD CONSTRAINT "fk_webhook_deliveries_webhook_id_org" FOREIGN KEY (org_id, webhook_id) REFERENCES build.project_webhooks(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_deliveries_webhook_id_org'
             AND conrelid = to_regclass('build.webhook_deliveries') AND NOT convalidated) THEN
    ALTER TABLE "build"."webhook_deliveries" VALIDATE CONSTRAINT "fk_webhook_deliveries_webhook_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.work_item_relations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_work_item_relations_related_work_item_id_org'
                     AND conrelid = to_regclass('build.work_item_relations')) THEN
    ALTER TABLE "build"."work_item_relations" ADD CONSTRAINT "fk_work_item_relations_related_work_item_id_org" FOREIGN KEY (org_id, related_work_item_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_work_item_relations_related_work_item_id_org'
             AND conrelid = to_regclass('build.work_item_relations') AND NOT convalidated) THEN
    ALTER TABLE "build"."work_item_relations" VALIDATE CONSTRAINT "fk_work_item_relations_related_work_item_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.workflow_transitions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_transitions_from_status_id_org'
                     AND conrelid = to_regclass('build.workflow_transitions')) THEN
    ALTER TABLE "build"."workflow_transitions" ADD CONSTRAINT "fk_workflow_transitions_from_status_id_org" FOREIGN KEY (org_id, from_status_id) REFERENCES build.project_statuses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_transitions_from_status_id_org'
             AND conrelid = to_regclass('build.workflow_transitions') AND NOT convalidated) THEN
    ALTER TABLE "build"."workflow_transitions" VALIDATE CONSTRAINT "fk_workflow_transitions_from_status_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.workflow_transitions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_transitions_project_id_org'
                     AND conrelid = to_regclass('build.workflow_transitions')) THEN
    ALTER TABLE "build"."workflow_transitions" ADD CONSTRAINT "fk_workflow_transitions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_transitions_project_id_org'
             AND conrelid = to_regclass('build.workflow_transitions') AND NOT convalidated) THEN
    ALTER TABLE "build"."workflow_transitions" VALIDATE CONSTRAINT "fk_workflow_transitions_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
