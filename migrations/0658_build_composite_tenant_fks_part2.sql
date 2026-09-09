-- =============================================================================
-- 0658 — Composite tenant foreign keys: build, part 2
-- =============================================================================
-- Build (projects, tickets, sprints, QA) — part 2 of 2.
--
-- 55 composite tenant foreign keys on build and build_events tables.
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
  IF to_regclass('build.project_programs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_programs_portfolio_id_org'
                     AND conrelid = to_regclass('build.project_programs')) THEN
    ALTER TABLE "build"."project_programs" ADD CONSTRAINT "fk_project_programs_portfolio_id_org" FOREIGN KEY (org_id, portfolio_id) REFERENCES "build"."project_portfolios"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_releases" ADD CONSTRAINT "fk_project_releases_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_risks" ADD CONSTRAINT "fk_project_risks_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_risks" ADD CONSTRAINT "fk_project_risks_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_statuses" ADD CONSTRAINT "fk_project_statuses_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_team_assignments" ADD CONSTRAINT "fk_project_team_assignments_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_team_assignments" ADD CONSTRAINT "fk_project_team_assignments_team_id_org" FOREIGN KEY (org_id, team_id) REFERENCES "build"."project_teams"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_team_members" ADD CONSTRAINT "fk_project_team_members_team_id_org" FOREIGN KEY (org_id, team_id) REFERENCES "build"."project_teams"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_template_tickets" ADD CONSTRAINT "fk_project_template_tickets_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "build"."project_templates"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_views" ADD CONSTRAINT "fk_project_views_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_webhooks" ADD CONSTRAINT "fk_project_webhooks_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_whiteboard_shares" ADD CONSTRAINT "fk_project_whiteboard_shares_whiteboard_id_org" FOREIGN KEY (org_id, whiteboard_id) REFERENCES "build"."project_whiteboards"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."project_whiteboards" ADD CONSTRAINT "fk_project_whiteboards_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."projects" ADD CONSTRAINT "fk_projects_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."projects" ADD CONSTRAINT "fk_projects_managed_product_id_org" FOREIGN KEY (org_id, managed_product_id) REFERENCES "build"."managed_products"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."release_tickets" ADD CONSTRAINT "fk_release_tickets_release_id_org" FOREIGN KEY (org_id, release_id) REFERENCES "build"."project_releases"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."release_tickets" ADD CONSTRAINT "fk_release_tickets_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."roadmap_items" ADD CONSTRAINT "fk_roadmap_items_epic_ticket_id_org" FOREIGN KEY (org_id, epic_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."roadmap_items" ADD CONSTRAINT "fk_roadmap_items_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."roadmap_votes" ADD CONSTRAINT "fk_roadmap_votes_roadmap_item_id_org" FOREIGN KEY (org_id, roadmap_item_id) REFERENCES "build"."roadmap_items"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."sprints" ADD CONSTRAINT "fk_sprints_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_cases" ADD CONSTRAINT "fk_test_cases_suite_id_org" FOREIGN KEY (org_id, suite_id) REFERENCES "build"."test_suites"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_linked_bug_id_org" FOREIGN KEY (org_id, linked_bug_id) REFERENCES "build"."bugs"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "build"."test_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_run_results" ADD CONSTRAINT "fk_test_run_results_test_case_id_org" FOREIGN KEY (org_id, test_case_id) REFERENCES "build"."test_cases"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_release_id_org" FOREIGN KEY (org_id, release_id) REFERENCES "build"."project_releases"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES "build"."sprints"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_suites" ADD CONSTRAINT "fk_test_suites_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES "build"."test_suites"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."test_suites" ADD CONSTRAINT "fk_test_suites_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_assignees_ticket_id_org'
                     AND conrelid = to_regclass('build.ticket_assignees')) THEN
    ALTER TABLE "build"."ticket_assignees" ADD CONSTRAINT "fk_ticket_assignees_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_attachments" ADD CONSTRAINT "fk_ticket_attachments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_checklist_items" ADD CONSTRAINT "fk_ticket_checklist_items_checklist_id_org" FOREIGN KEY (org_id, checklist_id) REFERENCES "build"."ticket_checklists"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_checklists" ADD CONSTRAINT "fk_ticket_checklists_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_comment_mentions" ADD CONSTRAINT "fk_ticket_comment_mentions_comment_id_org" FOREIGN KEY (org_id, comment_id) REFERENCES "build_events"."ticket_comments"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_comment_reactions" ADD CONSTRAINT "fk_ticket_comment_reactions_comment_id_org" FOREIGN KEY (org_id, comment_id) REFERENCES "build_events"."ticket_comments"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_label_mappings" ADD CONSTRAINT "fk_ticket_label_mappings_label_id_org" FOREIGN KEY (org_id, label_id) REFERENCES "build"."ticket_labels"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_label_mappings" ADD CONSTRAINT "fk_ticket_label_mappings_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_related_links" ADD CONSTRAINT "fk_ticket_related_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."ticket_watchers" ADD CONSTRAINT "fk_ticket_watchers_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_cycle_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "build"."cycles"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_epic_id_org" FOREIGN KEY (org_id, epic_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_module_id_org" FOREIGN KEY (org_id, module_id) REFERENCES "build"."modules"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tickets_sprint_id_org'
                     AND conrelid = to_regclass('build.tickets')) THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_sprint_id_org" FOREIGN KEY (org_id, sprint_id) REFERENCES "build"."sprints"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."webhook_deliveries" ADD CONSTRAINT "fk_webhook_deliveries_webhook_id_org" FOREIGN KEY (org_id, webhook_id) REFERENCES "build"."project_webhooks"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."work_item_relations" ADD CONSTRAINT "fk_work_item_relations_related_work_item_id_org" FOREIGN KEY (org_id, related_work_item_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."workflow_transitions" ADD CONSTRAINT "fk_workflow_transitions_from_status_id_org" FOREIGN KEY (org_id, from_status_id) REFERENCES "build"."project_statuses"(org_id, id) NOT VALID;
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
    ALTER TABLE "build"."workflow_transitions" ADD CONSTRAINT "fk_workflow_transitions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
DO $$ BEGIN
  IF to_regclass('build_events.ticket_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_activity_log_ticket_id_org'
                     AND conrelid = to_regclass('build_events.ticket_activity_log')) THEN
    ALTER TABLE "build_events"."ticket_activity_log" ADD CONSTRAINT "fk_ticket_activity_log_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "build_events"."ticket_comments" ADD CONSTRAINT "fk_ticket_comments_parent_comment_id_org" FOREIGN KEY (org_id, parent_comment_id) REFERENCES "build_events"."ticket_comments"(org_id, id) NOT VALID;
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
    ALTER TABLE "build_events"."ticket_comments" ADD CONSTRAINT "fk_ticket_comments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comments_ticket_id_org'
             AND conrelid = to_regclass('build_events.ticket_comments') AND NOT convalidated) THEN
    ALTER TABLE "build_events"."ticket_comments" VALIDATE CONSTRAINT "fk_ticket_comments_ticket_id_org";
  END IF;
END $$;
