-- =============================================================================
-- 0656 — Composite tenant foreign keys: the unique keys they reference
-- =============================================================================
-- The unique keys the composite tenant foreign keys reference.
--
-- This file must run before every other file in the series. A composite FK
-- REFERENCES x(org_id, id) requires a unique key on exactly those columns of x;
-- without it Postgres refuses the constraint with 42830, "there is no unique
-- constraint matching given keys for referenced table".
--
-- 174 tables are referenced by the 458 foreign keys in this series. 9 already
-- have their (org_id, id) key authored. The other 165 are in the same state the
-- foreign keys are: present on the Neon branch, named in no migration. So a
-- fresh build would have failed on the first ADD CONSTRAINT in 0657 even with
-- the foreign keys authored — the prerequisite has to be authored with them.
--
-- Each is taken verbatim from pg_get_constraintdef and guarded, so this is a
-- no-op on any database that already has them.
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_bugs_org_id'
                     AND conrelid = to_regclass('build.bugs')) THEN
    ALTER TABLE "build"."bugs" ADD CONSTRAINT "uniq_bugs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_cycles_org_id'
                     AND conrelid = to_regclass('build.cycles')) THEN
    ALTER TABLE "build"."cycles" ADD CONSTRAINT "uniq_cycles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedback_posts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_feedback_posts_org_id'
                     AND conrelid = to_regclass('build.feedback_posts')) THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "uniq_feedback_posts_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_feedbucket_submissions_org_id'
                     AND conrelid = to_regclass('build.feedbucket_submissions')) THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "uniq_feedbucket_submissions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.feedbucket_widgets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_feedbucket_widgets_org_id'
                     AND conrelid = to_regclass('build.feedbucket_widgets')) THEN
    ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT "uniq_feedbucket_widgets_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.git_connections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_git_connections_org_id'
                     AND conrelid = to_regclass('build.git_connections')) THEN
    ALTER TABLE "build"."git_connections" ADD CONSTRAINT "uniq_git_connections_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.modules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_modules_org_id'
                     AND conrelid = to_regclass('build.modules')) THEN
    ALTER TABLE "build"."modules" ADD CONSTRAINT "uniq_modules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_okr_goals_org_id'
                     AND conrelid = to_regclass('build.okr_goals')) THEN
    ALTER TABLE "build"."okr_goals" ADD CONSTRAINT "uniq_okr_goals_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.okr_key_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_okr_key_results_org_id'
                     AND conrelid = to_regclass('build.okr_key_results')) THEN
    ALTER TABLE "build"."okr_key_results" ADD CONSTRAINT "uniq_okr_key_results_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pages_org_id'
                     AND conrelid = to_regclass('build.pages')) THEN
    ALTER TABLE "build"."pages" ADD CONSTRAINT "uniq_pages_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_forms_org_id'
                     AND conrelid = to_regclass('build.project_forms')) THEN
    ALTER TABLE "build"."project_forms" ADD CONSTRAINT "uniq_project_forms_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_incidents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_incidents_org_id'
                     AND conrelid = to_regclass('build.project_incidents')) THEN
    ALTER TABLE "build"."project_incidents" ADD CONSTRAINT "uniq_project_incidents_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_meetings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_meetings_org_id'
                     AND conrelid = to_regclass('build.project_meetings')) THEN
    ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "uniq_project_meetings_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_portfolios') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_portfolios_org_id'
                     AND conrelid = to_regclass('build.project_portfolios')) THEN
    ALTER TABLE "build"."project_portfolios" ADD CONSTRAINT "uniq_project_portfolios_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_programs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_programs_org_id'
                     AND conrelid = to_regclass('build.project_programs')) THEN
    ALTER TABLE "build"."project_programs" ADD CONSTRAINT "uniq_project_programs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_releases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_releases_org_id'
                     AND conrelid = to_regclass('build.project_releases')) THEN
    ALTER TABLE "build"."project_releases" ADD CONSTRAINT "uniq_project_releases_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_statuses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_statuses_org_id'
                     AND conrelid = to_regclass('build.project_statuses')) THEN
    ALTER TABLE "build"."project_statuses" ADD CONSTRAINT "uniq_project_statuses_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_teams') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_teams_org_id'
                     AND conrelid = to_regclass('build.project_teams')) THEN
    ALTER TABLE "build"."project_teams" ADD CONSTRAINT "uniq_project_teams_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_templates_org_id'
                     AND conrelid = to_regclass('build.project_templates')) THEN
    ALTER TABLE "build"."project_templates" ADD CONSTRAINT "uniq_project_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_webhooks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_webhooks_org_id'
                     AND conrelid = to_regclass('build.project_webhooks')) THEN
    ALTER TABLE "build"."project_webhooks" ADD CONSTRAINT "uniq_project_webhooks_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.project_whiteboards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_whiteboards_org_id'
                     AND conrelid = to_regclass('build.project_whiteboards')) THEN
    ALTER TABLE "build"."project_whiteboards" ADD CONSTRAINT "uniq_project_whiteboards_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.projects') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_projects_org_id'
                     AND conrelid = to_regclass('build.projects')) THEN
    ALTER TABLE "build"."projects" ADD CONSTRAINT "uniq_projects_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.roadmap_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_roadmap_items_org_id'
                     AND conrelid = to_regclass('build.roadmap_items')) THEN
    ALTER TABLE "build"."roadmap_items" ADD CONSTRAINT "uniq_roadmap_items_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.sprints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sprints_org_id'
                     AND conrelid = to_regclass('build.sprints')) THEN
    ALTER TABLE "build"."sprints" ADD CONSTRAINT "uniq_sprints_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_cases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_test_cases_org_id'
                     AND conrelid = to_regclass('build.test_cases')) THEN
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "uniq_test_cases_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_test_runs_org_id'
                     AND conrelid = to_regclass('build.test_runs')) THEN
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "uniq_test_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.test_suites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_test_suites_org_id'
                     AND conrelid = to_regclass('build.test_suites')) THEN
    ALTER TABLE "build"."test_suites" ADD CONSTRAINT "uniq_test_suites_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_checklists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_ticket_checklists_org_id'
                     AND conrelid = to_regclass('build.ticket_checklists')) THEN
    ALTER TABLE "build"."ticket_checklists" ADD CONSTRAINT "uniq_ticket_checklists_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.ticket_labels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_ticket_labels_org_id'
                     AND conrelid = to_regclass('build.ticket_labels')) THEN
    ALTER TABLE "build"."ticket_labels" ADD CONSTRAINT "uniq_ticket_labels_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build.tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_tickets_org_id'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "uniq_tickets_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('build_events.ticket_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_ticket_comments_org_id'
                     AND conrelid = to_regclass('build_events.ticket_comments')) THEN
    ALTER TABLE "build_events"."ticket_comments" ADD CONSTRAINT "uniq_ticket_comments_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.ai_chat_conversations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_ai_chat_conversations_org_id'
                     AND conrelid = to_regclass('public.ai_chat_conversations')) THEN
    ALTER TABLE "public"."ai_chat_conversations" ADD CONSTRAINT "uniq_ai_chat_conversations_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.announcements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_announcements_org_id'
                     AND conrelid = to_regclass('public.announcements')) THEN
    ALTER TABLE "public"."announcements" ADD CONSTRAINT "uniq_announcements_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_assets_org_id'
                     AND conrelid = to_regclass('public.assets')) THEN
    ALTER TABLE "public"."assets" ADD CONSTRAINT "uniq_assets_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.automation_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_automation_rules_org_id'
                     AND conrelid = to_regclass('public.automation_rules')) THEN
    ALTER TABLE "public"."automation_rules" ADD CONSTRAINT "uniq_automation_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.biometric_devices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_biometric_devices_org_id'
                     AND conrelid = to_regclass('public.biometric_devices')) THEN
    ALTER TABLE "public"."biometric_devices" ADD CONSTRAINT "uniq_biometric_devices_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_calendar_events_org_id'
                     AND conrelid = to_regclass('public.calendar_events')) THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "uniq_calendar_events_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_calibration_sessions_org_id'
                     AND conrelid = to_regclass('public.calibration_sessions')) THEN
    ALTER TABLE "public"."calibration_sessions" ADD CONSTRAINT "uniq_calibration_sessions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_offers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_candidate_offers_org_id'
                     AND conrelid = to_regclass('public.candidate_offers')) THEN
    ALTER TABLE "public"."candidate_offers" ADD CONSTRAINT "uniq_candidate_offers_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_candidates_org_id'
                     AND conrelid = to_regclass('public.candidates')) THEN
    ALTER TABLE "public"."candidates" ADD CONSTRAINT "uniq_candidates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.career_paths') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_career_paths_org_id'
                     AND conrelid = to_regclass('public.career_paths')) THEN
    ALTER TABLE "public"."career_paths" ADD CONSTRAINT "uniq_career_paths_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_chat_channels_org_id'
                     AND conrelid = to_regclass('public.chat_channels')) THEN
    ALTER TABLE "public"."chat_channels" ADD CONSTRAINT "uniq_chat_channels_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_client_accounts_org_id'
                     AND conrelid = to_regclass('public.client_accounts')) THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "uniq_client_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_onboarding_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_client_onboarding_templates_org_id'
                     AND conrelid = to_regclass('public.client_onboarding_templates')) THEN
    ALTER TABLE "public"."client_onboarding_templates" ADD CONSTRAINT "uniq_client_onboarding_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.commission_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_commission_rules_org_id'
                     AND conrelid = to_regclass('public.commission_rules')) THEN
    ALTER TABLE "public"."commission_rules" ADD CONSTRAINT "uniq_commission_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.competency_frameworks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_competency_frameworks_org_id'
                     AND conrelid = to_regclass('public.competency_frameworks')) THEN
    ALTER TABLE "public"."competency_frameworks" ADD CONSTRAINT "uniq_competency_frameworks_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_automation_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_automation_rules_org_id'
                     AND conrelid = to_regclass('public.crm_automation_rules')) THEN
    ALTER TABLE "public"."crm_automation_rules" ADD CONSTRAINT "uniq_crm_automation_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_blueprints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_blueprints_org_id'
                     AND conrelid = to_regclass('public.crm_blueprints')) THEN
    ALTER TABLE "public"."crm_blueprints" ADD CONSTRAINT "uniq_crm_blueprints_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_campaigns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_campaigns_org_id'
                     AND conrelid = to_regclass('public.crm_campaigns')) THEN
    ALTER TABLE "public"."crm_campaigns" ADD CONSTRAINT "uniq_crm_campaigns_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_people') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_people_org_id'
                     AND conrelid = to_regclass('public.crm_people')) THEN
    ALTER TABLE "public"."crm_people" ADD CONSTRAINT "uniq_crm_people_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pipelines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_pipelines_org_id'
                     AND conrelid = to_regclass('public.crm_pipelines')) THEN
    ALTER TABLE "public"."crm_pipelines" ADD CONSTRAINT "uniq_crm_pipelines_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pricebooks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_pricebooks_org_id'
                     AND conrelid = to_regclass('public.crm_pricebooks')) THEN
    ALTER TABLE "public"."crm_pricebooks" ADD CONSTRAINT "uniq_crm_pricebooks_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_products_org_id'
                     AND conrelid = to_regclass('public.crm_products')) THEN
    ALTER TABLE "public"."crm_products" ADD CONSTRAINT "uniq_crm_products_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_sequences') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_sequences_org_id'
                     AND conrelid = to_regclass('public.crm_sequences')) THEN
    ALTER TABLE "public"."crm_sequences" ADD CONSTRAINT "uniq_crm_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.csat_surveys') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_csat_surveys_org_id'
                     AND conrelid = to_regclass('public.csat_surveys')) THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "uniq_csat_surveys_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_meetings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_deal_meetings_org_id'
                     AND conrelid = to_regclass('public.deal_meetings')) THEN
    ALTER TABLE "public"."deal_meetings" ADD CONSTRAINT "uniq_deal_meetings_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_document_templates_org_id'
                     AND conrelid = to_regclass('public.document_templates')) THEN
    ALTER TABLE "public"."document_templates" ADD CONSTRAINT "uniq_document_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_types') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_document_types_org_id'
                     AND conrelid = to_regclass('public.document_types')) THEN
    ALTER TABLE "public"."document_types" ADD CONSTRAINT "uniq_document_types_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_documents_org_id'
                     AND conrelid = to_regclass('public.documents')) THEN
    ALTER TABLE "public"."documents" ADD CONSTRAINT "uniq_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequences') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_email_sequences_org_id'
                     AND conrelid = to_regclass('public.email_sequences')) THEN
    ALTER TABLE "public"."email_sequences" ADD CONSTRAINT "uniq_email_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_salary_profiles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_employee_salary_profiles_org_id'
                     AND conrelid = to_regclass('public.employee_salary_profiles')) THEN
    ALTER TABLE "public"."employee_salary_profiles" ADD CONSTRAINT "uniq_employee_salary_profiles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expense_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_expense_categories_org_id'
                     AND conrelid = to_regclass('public.expense_categories')) THEN
    ALTER TABLE "public"."expense_categories" ADD CONSTRAINT "uniq_expense_categories_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.external_referrers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_external_referrers_org_id'
                     AND conrelid = to_regclass('public.external_referrers')) THEN
    ALTER TABLE "public"."external_referrers" ADD CONSTRAINT "uniq_external_referrers_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.feedback_cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_feedback_cycles_org_id'
                     AND conrelid = to_regclass('public.feedback_cycles')) THEN
    ALTER TABLE "public"."feedback_cycles" ADD CONSTRAINT "uniq_feedback_cycles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_goals_org_id'
                     AND conrelid = to_regclass('public.goals')) THEN
    ALTER TABLE "public"."goals" ADD CONSTRAINT "uniq_goals_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.helpdesk_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_helpdesk_tickets_org_id'
                     AND conrelid = to_regclass('public.helpdesk_tickets')) THEN
    ALTER TABLE "public"."helpdesk_tickets" ADD CONSTRAINT "uniq_helpdesk_tickets_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hiring_flows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hiring_flows_org_id'
                     AND conrelid = to_regclass('public.hiring_flows')) THEN
    ALTER TABLE "public"."hiring_flows" ADD CONSTRAINT "uniq_hiring_flows_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_accommodation_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_accommodation_requests_org_id'
                     AND conrelid = to_regclass('public.hr_accommodation_requests')) THEN
    ALTER TABLE "public"."hr_accommodation_requests" ADD CONSTRAINT "uniq_hr_accommodation_requests_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_automation_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_automation_rules_org_id'
                     AND conrelid = to_regclass('public.hr_automation_rules')) THEN
    ALTER TABLE "public"."hr_automation_rules" ADD CONSTRAINT "uniq_hr_automation_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_badges') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_badges_org_id'
                     AND conrelid = to_regclass('public.hr_badges')) THEN
    ALTER TABLE "public"."hr_badges" ADD CONSTRAINT "uniq_hr_badges_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_benefit_plans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_benefit_plans_org_id'
                     AND conrelid = to_regclass('public.hr_benefit_plans')) THEN
    ALTER TABLE "public"."hr_benefit_plans" ADD CONSTRAINT "uniq_hr_benefit_plans_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_cases') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_cases_org_id'
                     AND conrelid = to_regclass('public.hr_cases')) THEN
    ALTER TABLE "public"."hr_cases" ADD CONSTRAINT "uniq_hr_cases_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_communities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_communities_org_id'
                     AND conrelid = to_regclass('public.hr_communities')) THEN
    ALTER TABLE "public"."hr_communities" ADD CONSTRAINT "uniq_hr_communities_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_comp_cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_comp_cycles_org_id'
                     AND conrelid = to_regclass('public.hr_comp_cycles')) THEN
    ALTER TABLE "public"."hr_comp_cycles" ADD CONSTRAINT "uniq_hr_comp_cycles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_compliance_requirements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_compliance_requirements_org_id'
                     AND conrelid = to_regclass('public.hr_compliance_requirements')) THEN
    ALTER TABLE "public"."hr_compliance_requirements" ADD CONSTRAINT "uniq_hr_compliance_requirements_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_emergency_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_emergency_events_org_id'
                     AND conrelid = to_regclass('public.hr_emergency_events')) THEN
    ALTER TABLE "public"."hr_emergency_events" ADD CONSTRAINT "uniq_hr_emergency_events_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_employments_org_id'
                     AND conrelid = to_regclass('public.hr_employments')) THEN
    ALTER TABLE "public"."hr_employments" ADD CONSTRAINT "uniq_hr_employments_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_equity_grants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_equity_grants_org_id'
                     AND conrelid = to_regclass('public.hr_equity_grants')) THEN
    ALTER TABLE "public"."hr_equity_grants" ADD CONSTRAINT "uniq_hr_equity_grants_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_forms_org_id'
                     AND conrelid = to_regclass('public.hr_forms')) THEN
    ALTER TABLE "public"."hr_forms" ADD CONSTRAINT "uniq_hr_forms_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_import_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_import_jobs_org_id'
                     AND conrelid = to_regclass('public.hr_import_jobs')) THEN
    ALTER TABLE "public"."hr_import_jobs" ADD CONSTRAINT "uniq_hr_import_jobs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_job_roles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_job_roles_org_id'
                     AND conrelid = to_regclass('public.hr_job_roles')) THEN
    ALTER TABLE "public"."hr_job_roles" ADD CONSTRAINT "uniq_hr_job_roles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_legal_holds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_legal_holds_org_id'
                     AND conrelid = to_regclass('public.hr_legal_holds')) THEN
    ALTER TABLE "public"."hr_legal_holds" ADD CONSTRAINT "uniq_hr_legal_holds_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_payroll_input_periods') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_payroll_input_periods_org_id'
                     AND conrelid = to_regclass('public.hr_payroll_input_periods')) THEN
    ALTER TABLE "public"."hr_payroll_input_periods" ADD CONSTRAINT "uniq_hr_payroll_input_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_people') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_people_org_id'
                     AND conrelid = to_regclass('public.hr_people')) THEN
    ALTER TABLE "public"."hr_people" ADD CONSTRAINT "uniq_hr_people_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_policies_org_id'
                     AND conrelid = to_regclass('public.hr_policies')) THEN
    ALTER TABLE "public"."hr_policies" ADD CONSTRAINT "uniq_hr_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_polls') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_polls_org_id'
                     AND conrelid = to_regclass('public.hr_polls')) THEN
    ALTER TABLE "public"."hr_polls" ADD CONSTRAINT "uniq_hr_polls_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_templates_org_id'
                     AND conrelid = to_regclass('public.hr_templates')) THEN
    ALTER TABLE "public"."hr_templates" ADD CONSTRAINT "uniq_hr_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_time_devices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_time_devices_org_id'
                     AND conrelid = to_regclass('public.hr_time_devices')) THEN
    ALTER TABLE "public"."hr_time_devices" ADD CONSTRAINT "uniq_hr_time_devices_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_webhook_subscriptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_webhook_subscriptions_org_id'
                     AND conrelid = to_regclass('public.hr_webhook_subscriptions')) THEN
    ALTER TABLE "public"."hr_webhook_subscriptions" ADD CONSTRAINT "uniq_hr_webhook_subscriptions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_definitions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_workflow_definitions_org_id'
                     AND conrelid = to_regclass('public.hr_workflow_definitions')) THEN
    ALTER TABLE "public"."hr_workflow_definitions" ADD CONSTRAINT "uniq_hr_workflow_definitions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_instances') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_hr_workflow_instances_org_id'
                     AND conrelid = to_regclass('public.hr_workflow_instances')) THEN
    ALTER TABLE "public"."hr_workflow_instances" ADD CONSTRAINT "uniq_hr_workflow_instances_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_booking_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_interview_booking_links_org_id'
                     AND conrelid = to_regclass('public.interview_booking_links')) THEN
    ALTER TABLE "public"."interview_booking_links" ADD CONSTRAINT "uniq_interview_booking_links_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_interviews_org_id'
                     AND conrelid = to_regclass('public.interviews')) THEN
    ALTER TABLE "public"."interviews" ADD CONSTRAINT "uniq_interviews_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_invoices_org_id'
                     AND conrelid = to_regclass('public.invoices')) THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "uniq_invoices_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_postings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_job_postings_org_id'
                     AND conrelid = to_regclass('public.job_postings')) THEN
    ALTER TABLE "public"."job_postings" ADD CONSTRAINT "uniq_job_postings_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_article_attachments_org_id'
                     AND conrelid = to_regclass('public.kb_article_attachments')) THEN
    ALTER TABLE "public"."kb_article_attachments" ADD CONSTRAINT "uniq_kb_article_attachments_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_articles_org_id'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "uniq_kb_articles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_categories_org_id'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "uniq_kb_categories_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_chat_conversations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_chat_conversations_org_id'
                     AND conrelid = to_regclass('public.kb_chat_conversations')) THEN
    ALTER TABLE "public"."kb_chat_conversations" ADD CONSTRAINT "uniq_kb_chat_conversations_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_page_comments_org_id'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "uniq_kb_page_comments_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_pages_org_id'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "uniq_kb_pages_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_sources') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_sources_org_id'
                     AND conrelid = to_regclass('public.kb_sources')) THEN
    ALTER TABLE "public"."kb_sources" ADD CONSTRAINT "uniq_kb_sources_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_spaces') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_spaces_org_id'
                     AND conrelid = to_regclass('public.kb_spaces')) THEN
    ALTER TABLE "public"."kb_spaces" ADD CONSTRAINT "uniq_kb_spaces_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_tags_org_id'
                     AND conrelid = to_regclass('public.kb_tags')) THEN
    ALTER TABLE "public"."kb_tags" ADD CONSTRAINT "uniq_kb_tags_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_assignment_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_lead_assignment_rules_org_id'
                     AND conrelid = to_regclass('public.lead_assignment_rules')) THEN
    ALTER TABLE "public"."lead_assignment_rules" ADD CONSTRAINT "uniq_lead_assignment_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_types') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_leave_types_org_id'
                     AND conrelid = to_regclass('public.leave_types')) THEN
    ALTER TABLE "public"."leave_types" ADD CONSTRAINT "uniq_leave_types_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.module_setup_checklists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_module_setup_checklists_org_id'
                     AND conrelid = to_regclass('public.module_setup_checklists')) THEN
    ALTER TABLE "public"."module_setup_checklists" ADD CONSTRAINT "uniq_module_setup_checklists_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.nps_surveys') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_nps_surveys_org_id'
                     AND conrelid = to_regclass('public.nps_surveys')) THEN
    ALTER TABLE "public"."nps_surveys" ADD CONSTRAINT "uniq_nps_surveys_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_onboarding_documents_org_id'
                     AND conrelid = to_regclass('public.onboarding_documents')) THEN
    ALTER TABLE "public"."onboarding_documents" ADD CONSTRAINT "uniq_onboarding_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_template_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_onboarding_template_steps_org_id'
                     AND conrelid = to_regclass('public.onboarding_template_steps')) THEN
    ALTER TABLE "public"."onboarding_template_steps" ADD CONSTRAINT "uniq_onboarding_template_steps_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_onboarding_templates_org_id'
                     AND conrelid = to_regclass('public.onboarding_templates')) THEN
    ALTER TABLE "public"."onboarding_templates" ADD CONSTRAINT "uniq_onboarding_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_providers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payment_providers_org_id'
                     AND conrelid = to_regclass('public.payment_providers')) THEN
    ALTER TABLE "public"."payment_providers" ADD CONSTRAINT "uniq_payment_providers_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_entities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_entities_org_id'
                     AND conrelid = to_regclass('public.payroll_entities')) THEN
    ALTER TABLE "public"."payroll_entities" ADD CONSTRAINT "uniq_payroll_entities_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_journal_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_journal_batches_org_id'
                     AND conrelid = to_regclass('public.payroll_journal_batches')) THEN
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "uniq_payroll_journal_batches_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_periods') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_periods_org_id'
                     AND conrelid = to_regclass('public.payroll_periods')) THEN
    ALTER TABLE "public"."payroll_periods" ADD CONSTRAINT "uniq_payroll_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_policies_org_id'
                     AND conrelid = to_regclass('public.payroll_policies')) THEN
    ALTER TABLE "public"."payroll_policies" ADD CONSTRAINT "uniq_payroll_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_policy_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_policy_versions_org_id'
                     AND conrelid = to_regclass('public.payroll_policy_versions')) THEN
    ALTER TABLE "public"."payroll_policy_versions" ADD CONSTRAINT "uniq_payroll_policy_versions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_run_employees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_run_employees_org_id'
                     AND conrelid = to_regclass('public.payroll_run_employees')) THEN
    ALTER TABLE "public"."payroll_run_employees" ADD CONSTRAINT "uniq_payroll_run_employees_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payroll_runs_org_id'
                     AND conrelid = to_regclass('public.payroll_runs')) THEN
    ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "uniq_payroll_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payslip_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_payslip_templates_org_id'
                     AND conrelid = to_regclass('public.payslip_templates')) THEN
    ALTER TABLE "public"."payslip_templates" ADD CONSTRAINT "uniq_payslip_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.pulse_surveys') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pulse_surveys_org_id'
                     AND conrelid = to_regclass('public.pulse_surveys')) THEN
    ALTER TABLE "public"."pulse_surveys" ADD CONSTRAINT "uniq_pulse_surveys_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.purchase_bills') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_purchase_bills_org_id'
                     AND conrelid = to_regclass('public.purchase_bills')) THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "uniq_purchase_bills_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recruitment_vendors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_recruitment_vendors_org_id'
                     AND conrelid = to_regclass('public.recruitment_vendors')) THEN
    ALTER TABLE "public"."recruitment_vendors" ADD CONSTRAINT "uniq_recruitment_vendors_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.resignations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_resignations_org_id'
                     AND conrelid = to_regclass('public.resignations')) THEN
    ALTER TABLE "public"."resignations" ADD CONSTRAINT "uniq_resignations_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.review_cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_review_cycles_org_id'
                     AND conrelid = to_regclass('public.review_cycles')) THEN
    ALTER TABLE "public"."review_cycles" ADD CONSTRAINT "uniq_review_cycles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.rich_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_rich_documents_org_id'
                     AND conrelid = to_regclass('public.rich_documents')) THEN
    ALTER TABLE "public"."rich_documents" ADD CONSTRAINT "uniq_rich_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.roles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_roles_org_id'
                     AND conrelid = to_regclass('public.roles')) THEN
    ALTER TABLE "public"."roles" ADD CONSTRAINT "uniq_roles_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.rosters') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_rosters_org_id'
                     AND conrelid = to_regclass('public.rosters')) THEN
    ALTER TABLE "public"."rosters" ADD CONSTRAINT "uniq_rosters_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.salary_components') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_salary_components_org_id'
                     AND conrelid = to_regclass('public.salary_components')) THEN
    ALTER TABLE "public"."salary_components" ADD CONSTRAINT "uniq_salary_components_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.salary_loans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_salary_loans_org_id'
                     AND conrelid = to_regclass('public.salary_loans')) THEN
    ALTER TABLE "public"."salary_loans" ADD CONSTRAINT "uniq_salary_loans_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.scorecard_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_scorecard_templates_org_id'
                     AND conrelid = to_regclass('public.scorecard_templates')) THEN
    ALTER TABLE "public"."scorecard_templates" ADD CONSTRAINT "uniq_scorecard_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.shift_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_shift_templates_org_id'
                     AND conrelid = to_regclass('public.shift_templates')) THEN
    ALTER TABLE "public"."shift_templates" ADD CONSTRAINT "uniq_shift_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_bulk_send_jobs_org_id'
                     AND conrelid = to_regclass('public.sign_bulk_send_jobs')) THEN
    ALTER TABLE "public"."sign_bulk_send_jobs" ADD CONSTRAINT "uniq_sign_bulk_send_jobs_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_documents_org_id'
                     AND conrelid = to_regclass('public.sign_documents')) THEN
    ALTER TABLE "public"."sign_documents" ADD CONSTRAINT "uniq_sign_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_envelopes_org_id'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "uniq_sign_envelopes_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_public_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_public_forms_org_id'
                     AND conrelid = to_regclass('public.sign_public_forms')) THEN
    ALTER TABLE "public"."sign_public_forms" ADD CONSTRAINT "uniq_sign_public_forms_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_recipients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_recipients_org_id'
                     AND conrelid = to_regclass('public.sign_recipients')) THEN
    ALTER TABLE "public"."sign_recipients" ADD CONSTRAINT "uniq_sign_recipients_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_templates_org_id'
                     AND conrelid = to_regclass('public.sign_templates')) THEN
    ALTER TABLE "public"."sign_templates" ADD CONSTRAINT "uniq_sign_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_watermark_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_sign_watermark_policies_org_id'
                     AND conrelid = to_regclass('public.sign_watermark_policies')) THEN
    ALTER TABLE "public"."sign_watermark_policies" ADD CONSTRAINT "uniq_sign_watermark_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.skill_assessments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_skill_assessments_org_id'
                     AND conrelid = to_regclass('public.skill_assessments')) THEN
    ALTER TABLE "public"."skill_assessments" ADD CONSTRAINT "uniq_skill_assessments_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.subscriptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_subscriptions_org_id'
                     AND conrelid = to_regclass('public.subscriptions')) THEN
    ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "uniq_subscriptions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_support_tags_org_id'
                     AND conrelid = to_regclass('public.support_tags')) THEN
    ALTER TABLE "public"."support_tags" ADD CONSTRAINT "uniq_support_tags_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_support_ticket_messages_org_id'
                     AND conrelid = to_regclass('public.support_ticket_messages')) THEN
    ALTER TABLE "public"."support_ticket_messages" ADD CONSTRAINT "uniq_support_ticket_messages_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_support_tickets_org_id'
                     AND conrelid = to_regclass('public.support_tickets')) THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "uniq_support_tickets_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_assessment_attempts_org_id'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "uniq_survey_assessment_attempts_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_collectors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_collectors_org_id'
                     AND conrelid = to_regclass('public.survey_collectors')) THEN
    ALTER TABLE "public"."survey_collectors" ADD CONSTRAINT "uniq_survey_collectors_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_forms_org_id'
                     AND conrelid = to_regclass('public.survey_forms')) THEN
    ALTER TABLE "public"."survey_forms" ADD CONSTRAINT "uniq_survey_forms_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_participants_org_id'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "uniq_survey_participants_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_questions_org_id'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "uniq_survey_questions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_response_sessions_org_id'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "uniq_survey_response_sessions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_sections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_sections_org_id'
                     AND conrelid = to_regclass('public.survey_sections')) THEN
    ALTER TABLE "public"."survey_sections" ADD CONSTRAINT "uniq_survey_sections_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_survey_versions_org_id'
                     AND conrelid = to_regclass('public.survey_versions')) THEN
    ALTER TABLE "public"."survey_versions" ADD CONSTRAINT "uniq_survey_versions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.talent_pools') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_talent_pools_org_id'
                     AND conrelid = to_regclass('public.talent_pools')) THEN
    ALTER TABLE "public"."talent_pools" ADD CONSTRAINT "uniq_talent_pools_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.task_sequences') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_task_sequences_org_id'
                     AND conrelid = to_regclass('public.task_sequences')) THEN
    ALTER TABLE "public"."task_sequences" ADD CONSTRAINT "uniq_task_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_tasks_org_id'
                     AND conrelid = to_regclass('public.tasks')) THEN
    ALTER TABLE "public"."tasks" ADD CONSTRAINT "uniq_tasks_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.tax_declarations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_tax_declarations_org_id'
                     AND conrelid = to_regclass('public.tax_declarations')) THEN
    ALTER TABLE "public"."tax_declarations" ADD CONSTRAINT "uniq_tax_declarations_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.team_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_team_events_org_id'
                     AND conrelid = to_regclass('public.team_events')) THEN
    ALTER TABLE "public"."team_events" ADD CONSTRAINT "uniq_team_events_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timer_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_timer_sessions_org_id'
                     AND conrelid = to_regclass('public.timer_sessions')) THEN
    ALTER TABLE "public"."timer_sessions" ADD CONSTRAINT "uniq_timer_sessions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_exports') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_timesheet_exports_org_id'
                     AND conrelid = to_regclass('public.timesheet_exports')) THEN
    ALTER TABLE "public"."timesheet_exports" ADD CONSTRAINT "uniq_timesheet_exports_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_periods') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_timesheet_periods_org_id'
                     AND conrelid = to_regclass('public.timesheet_periods')) THEN
    ALTER TABLE "public"."timesheet_periods" ADD CONSTRAINT "uniq_timesheet_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_rate_cards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_timesheet_rate_cards_org_id'
                     AND conrelid = to_regclass('public.timesheet_rate_cards')) THEN
    ALTER TABLE "public"."timesheet_rate_cards" ADD CONSTRAINT "uniq_timesheet_rate_cards_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.webhook_endpoints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_webhook_endpoints_org_id'
                     AND conrelid = to_regclass('public.webhook_endpoints')) THEN
    ALTER TABLE "public"."webhook_endpoints" ADD CONSTRAINT "uniq_webhook_endpoints_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_execution_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_workflow_execution_steps_org_id'
                     AND conrelid = to_regclass('public.workflow_execution_steps')) THEN
    ALTER TABLE "public"."workflow_execution_steps" ADD CONSTRAINT "uniq_workflow_execution_steps_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_executions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_workflow_executions_org_id'
                     AND conrelid = to_regclass('public.workflow_executions')) THEN
    ALTER TABLE "public"."workflow_executions" ADD CONSTRAINT "uniq_workflow_executions_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_workflows_org_id'
                     AND conrelid = to_regclass('public.workflows')) THEN
    ALTER TABLE "public"."workflows" ADD CONSTRAINT "uniq_workflows_org_id" UNIQUE (org_id, id);
  END IF;
END $$;
