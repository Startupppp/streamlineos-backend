-- =============================================================================
-- 0662 — Composite tenant foreign keys: CRM and sign
-- =============================================================================
-- CRM, accounting and e-signature.
--
-- 60 composite tenant foreign keys.
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
  IF to_regclass('public.acc_asset_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_asset_categories_accumulated_depreciation_account_id_org'
                     AND conrelid = to_regclass('public.acc_asset_categories')) THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "fk_acc_asset_categories_accumulated_depreciation_account_id_org" FOREIGN KEY (org_id, accumulated_depreciation_account_id) REFERENCES "public"."ledger_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_asset_categories_accumulated_depreciation_account_id_org'
             AND conrelid = to_regclass('public.acc_asset_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_asset_categories" VALIDATE CONSTRAINT "fk_acc_asset_categories_accumulated_depreciation_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_account_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_account_activities_client_account_id_org'
                     AND conrelid = to_regclass('public.client_account_activities')) THEN
    ALTER TABLE "public"."client_account_activities" ADD CONSTRAINT "fk_client_account_activities_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_account_activities_client_account_id_org'
             AND conrelid = to_regclass('public.client_account_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_account_activities" VALIDATE CONSTRAINT "fk_client_account_activities_client_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_health_scores') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_health_scores_client_account_id_org'
                     AND conrelid = to_regclass('public.client_health_scores')) THEN
    ALTER TABLE "public"."client_health_scores" ADD CONSTRAINT "fk_client_health_scores_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_health_scores_client_account_id_org'
             AND conrelid = to_regclass('public.client_health_scores') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_health_scores" VALIDATE CONSTRAINT "fk_client_health_scores_client_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_onboarding_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_template_id_org'
                     AND conrelid = to_regclass('public.client_onboarding_items')) THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."client_onboarding_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_template_id_org'
             AND conrelid = to_regclass('public.client_onboarding_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_activities_person_id_org'
                     AND conrelid = to_regclass('public.crm_activities')) THEN
    ALTER TABLE "public"."crm_activities" ADD CONSTRAINT "fk_crm_activities_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES "public"."crm_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_activities_person_id_org'
             AND conrelid = to_regclass('public.crm_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_activities" VALIDATE CONSTRAINT "fk_crm_activities_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_automation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_automation_runs_rule_id_org'
                     AND conrelid = to_regclass('public.crm_automation_runs')) THEN
    ALTER TABLE "public"."crm_automation_runs" ADD CONSTRAINT "fk_crm_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES "public"."crm_automation_rules"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_automation_runs_rule_id_org'
             AND conrelid = to_regclass('public.crm_automation_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_automation_runs" VALIDATE CONSTRAINT "fk_crm_automation_runs_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_blueprint_transitions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_blueprint_transitions_blueprint_id_org'
                     AND conrelid = to_regclass('public.crm_blueprint_transitions')) THEN
    ALTER TABLE "public"."crm_blueprint_transitions" ADD CONSTRAINT "fk_crm_blueprint_transitions_blueprint_id_org" FOREIGN KEY (org_id, blueprint_id) REFERENCES "public"."crm_blueprints"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_blueprint_transitions_blueprint_id_org'
             AND conrelid = to_regclass('public.crm_blueprint_transitions') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_blueprint_transitions" VALIDATE CONSTRAINT "fk_crm_blueprint_transitions_blueprint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_blueprints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_blueprints_pipeline_id_org'
                     AND conrelid = to_regclass('public.crm_blueprints')) THEN
    ALTER TABLE "public"."crm_blueprints" ADD CONSTRAINT "fk_crm_blueprints_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES "public"."crm_pipelines"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_blueprints_pipeline_id_org'
             AND conrelid = to_regclass('public.crm_blueprints') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_blueprints" VALIDATE CONSTRAINT "fk_crm_blueprints_pipeline_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_companies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_companies_csm_id_org'
                     AND conrelid = to_regclass('public.crm_companies')) THEN
    ALTER TABLE "public"."crm_companies" ADD CONSTRAINT "fk_crm_companies_csm_id_org" FOREIGN KEY (org_id, csm_id) REFERENCES "public"."crm_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_companies_csm_id_org'
             AND conrelid = to_regclass('public.crm_companies') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_companies" VALIDATE CONSTRAINT "fk_crm_companies_csm_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deal_competitors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_competitors_deal_id_org'
                     AND conrelid = to_regclass('public.crm_deal_competitors')) THEN
    ALTER TABLE "public"."crm_deal_competitors" ADD CONSTRAINT "fk_crm_deal_competitors_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_competitors_deal_id_org'
             AND conrelid = to_regclass('public.crm_deal_competitors') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_deal_competitors" VALIDATE CONSTRAINT "fk_crm_deal_competitors_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deal_stakeholders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_deal_id_org'
                     AND conrelid = to_regclass('public.crm_deal_stakeholders')) THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_deal_id_org'
             AND conrelid = to_regclass('public.crm_deal_stakeholders') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_deal_stakeholders" VALIDATE CONSTRAINT "fk_crm_deal_stakeholders_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deals_sales_rep_id_org'
                     AND conrelid = to_regclass('public.crm_deals')) THEN
    ALTER TABLE "public"."crm_deals" ADD CONSTRAINT "fk_crm_deals_sales_rep_id_org" FOREIGN KEY (org_id, sales_rep_id) REFERENCES "public"."crm_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deals_sales_rep_id_org'
             AND conrelid = to_regclass('public.crm_deals') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_deals" VALIDATE CONSTRAINT "fk_crm_deals_sales_rep_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_lead_touchpoints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_campaign_id_org'
                     AND conrelid = to_regclass('public.crm_lead_touchpoints')) THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_campaign_id_org" FOREIGN KEY (org_id, campaign_id) REFERENCES "public"."crm_campaigns"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_campaign_id_org'
             AND conrelid = to_regclass('public.crm_lead_touchpoints') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_lead_touchpoints" VALIDATE CONSTRAINT "fk_crm_lead_touchpoints_campaign_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pipeline_stages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pipeline_stages_pipeline_id_org'
                     AND conrelid = to_regclass('public.crm_pipeline_stages')) THEN
    ALTER TABLE "public"."crm_pipeline_stages" ADD CONSTRAINT "fk_crm_pipeline_stages_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES "public"."crm_pipelines"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pipeline_stages_pipeline_id_org'
             AND conrelid = to_regclass('public.crm_pipeline_stages') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_pipeline_stages" VALIDATE CONSTRAINT "fk_crm_pipeline_stages_pipeline_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pricebook_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pricebook_entries_pricebook_id_org'
                     AND conrelid = to_regclass('public.crm_pricebook_entries')) THEN
    ALTER TABLE "public"."crm_pricebook_entries" ADD CONSTRAINT "fk_crm_pricebook_entries_pricebook_id_org" FOREIGN KEY (org_id, pricebook_id) REFERENCES "public"."crm_pricebooks"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pricebook_entries_pricebook_id_org'
             AND conrelid = to_regclass('public.crm_pricebook_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_pricebook_entries" VALIDATE CONSTRAINT "fk_crm_pricebook_entries_pricebook_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pricebook_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pricebook_entries_product_id_org'
                     AND conrelid = to_regclass('public.crm_pricebook_entries')) THEN
    ALTER TABLE "public"."crm_pricebook_entries" ADD CONSTRAINT "fk_crm_pricebook_entries_product_id_org" FOREIGN KEY (org_id, product_id) REFERENCES "public"."crm_products"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pricebook_entries_product_id_org'
             AND conrelid = to_regclass('public.crm_pricebook_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_pricebook_entries" VALIDATE CONSTRAINT "fk_crm_pricebook_entries_product_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_sequence_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_sequence_enrollments_sequence_id_org'
                     AND conrelid = to_regclass('public.crm_sequence_enrollments')) THEN
    ALTER TABLE "public"."crm_sequence_enrollments" ADD CONSTRAINT "fk_crm_sequence_enrollments_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES "public"."crm_sequences"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_sequence_enrollments_sequence_id_org'
             AND conrelid = to_regclass('public.crm_sequence_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_sequence_enrollments" VALIDATE CONSTRAINT "fk_crm_sequence_enrollments_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_sequence_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_sequence_steps_sequence_id_org'
                     AND conrelid = to_regclass('public.crm_sequence_steps')) THEN
    ALTER TABLE "public"."crm_sequence_steps" ADD CONSTRAINT "fk_crm_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES "public"."crm_sequences"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_sequence_steps_sequence_id_org'
             AND conrelid = to_regclass('public.crm_sequence_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_sequence_steps" VALIDATE CONSTRAINT "fk_crm_sequence_steps_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_support_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_support_tickets_assignee_id_org'
                     AND conrelid = to_regclass('public.crm_support_tickets')) THEN
    ALTER TABLE "public"."crm_support_tickets" ADD CONSTRAINT "fk_crm_support_tickets_assignee_id_org" FOREIGN KEY (org_id, assignee_id) REFERENCES "public"."crm_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_support_tickets_assignee_id_org'
             AND conrelid = to_regclass('public.crm_support_tickets') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_support_tickets" VALIDATE CONSTRAINT "fk_crm_support_tickets_assignee_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_team_performance') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_team_performance_person_id_org'
                     AND conrelid = to_regclass('public.crm_team_performance')) THEN
    ALTER TABLE "public"."crm_team_performance" ADD CONSTRAINT "fk_crm_team_performance_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES "public"."crm_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_team_performance_person_id_org'
             AND conrelid = to_regclass('public.crm_team_performance') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_team_performance" VALIDATE CONSTRAINT "fk_crm_team_performance_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_activities_deal_id_org'
                     AND conrelid = to_regclass('public.deal_activities')) THEN
    ALTER TABLE "public"."deal_activities" ADD CONSTRAINT "fk_deal_activities_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_activities_deal_id_org'
             AND conrelid = to_regclass('public.deal_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."deal_activities" VALIDATE CONSTRAINT "fk_deal_activities_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_approvals_deal_id_org'
                     AND conrelid = to_regclass('public.deal_approvals')) THEN
    ALTER TABLE "public"."deal_approvals" ADD CONSTRAINT "fk_deal_approvals_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_approvals_deal_id_org'
             AND conrelid = to_regclass('public.deal_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."deal_approvals" VALIDATE CONSTRAINT "fk_deal_approvals_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_meeting_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_meeting_attendees_meeting_id_org'
                     AND conrelid = to_regclass('public.deal_meeting_attendees')) THEN
    ALTER TABLE "public"."deal_meeting_attendees" ADD CONSTRAINT "fk_deal_meeting_attendees_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES "public"."deal_meetings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_meeting_attendees_meeting_id_org'
             AND conrelid = to_regclass('public.deal_meeting_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."deal_meeting_attendees" VALIDATE CONSTRAINT "fk_deal_meeting_attendees_meeting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_meetings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_meetings_deal_id_org'
                     AND conrelid = to_regclass('public.deal_meetings')) THEN
    ALTER TABLE "public"."deal_meetings" ADD CONSTRAINT "fk_deal_meetings_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_meetings_deal_id_org'
             AND conrelid = to_regclass('public.deal_meetings') AND NOT convalidated) THEN
    ALTER TABLE "public"."deal_meetings" VALIDATE CONSTRAINT "fk_deal_meetings_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_pipeline_id_org'
                     AND conrelid = to_regclass('public.deals')) THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES "public"."crm_pipelines"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_pipeline_id_org'
             AND conrelid = to_regclass('public.deals') AND NOT convalidated) THEN
    ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_pipeline_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.enterprise_quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enterprise_quotes_client_id_org'
                     AND conrelid = to_regclass('public.enterprise_quotes')) THEN
    ALTER TABLE "public"."enterprise_quotes" ADD CONSTRAINT "fk_enterprise_quotes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enterprise_quotes_client_id_org'
             AND conrelid = to_regclass('public.enterprise_quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."enterprise_quotes" VALIDATE CONSTRAINT "fk_enterprise_quotes_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.enterprise_quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enterprise_quotes_deal_id_org'
                     AND conrelid = to_regclass('public.enterprise_quotes')) THEN
    ALTER TABLE "public"."enterprise_quotes" ADD CONSTRAINT "fk_enterprise_quotes_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enterprise_quotes_deal_id_org'
             AND conrelid = to_regclass('public.enterprise_quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."enterprise_quotes" VALIDATE CONSTRAINT "fk_enterprise_quotes_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expenses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_category_id_org'
                     AND conrelid = to_regclass('public.expenses')) THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES "public"."expense_categories"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_category_id_org'
             AND conrelid = to_regclass('public.expenses') AND NOT convalidated) THEN
    ALTER TABLE "public"."expenses" VALIDATE CONSTRAINT "fk_expenses_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expenses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_project_id_org'
                     AND conrelid = to_regclass('public.expenses')) THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_project_id_org'
             AND conrelid = to_regclass('public.expenses') AND NOT convalidated) THEN
    ALTER TABLE "public"."expenses" VALIDATE CONSTRAINT "fk_expenses_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.external_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_candidate_id_org'
                     AND conrelid = to_regclass('public.external_referrals')) THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_candidate_id_org'
             AND conrelid = to_regclass('public.external_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."external_referrals" VALIDATE CONSTRAINT "fk_external_referrals_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.external_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_job_posting_id_org'
                     AND conrelid = to_regclass('public.external_referrals')) THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_job_posting_id_org'
             AND conrelid = to_regclass('public.external_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."external_referrals" VALIDATE CONSTRAINT "fk_external_referrals_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.external_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_referrer_id_org'
                     AND conrelid = to_regclass('public.external_referrals')) THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_referrer_id_org" FOREIGN KEY (org_id, referrer_id) REFERENCES "public"."external_referrers"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_external_referrals_referrer_id_org'
             AND conrelid = to_regclass('public.external_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."external_referrals" VALIDATE CONSTRAINT "fk_external_referrals_referrer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoice_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_items_invoice_id_org'
                     AND conrelid = to_regclass('public.invoice_items')) THEN
    ALTER TABLE "public"."invoice_items" ADD CONSTRAINT "fk_invoice_items_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES "public"."invoices"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_items_invoice_id_org'
             AND conrelid = to_regclass('public.invoice_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoice_items" VALIDATE CONSTRAINT "fk_invoice_items_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_project_id_org'
                     AND conrelid = to_regclass('public.invoices')) THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_project_id_org'
             AND conrelid = to_regclass('public.invoices') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoices" VALIDATE CONSTRAINT "fk_invoices_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.purchase_bill_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bill_items_bill_id_org'
                     AND conrelid = to_regclass('public.purchase_bill_items')) THEN
    ALTER TABLE "public"."purchase_bill_items" ADD CONSTRAINT "fk_purchase_bill_items_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES "public"."purchase_bills"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bill_items_bill_id_org'
             AND conrelid = to_regclass('public.purchase_bill_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."purchase_bill_items" VALIDATE CONSTRAINT "fk_purchase_bill_items_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quote_line_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quote_line_items_quote_id_org'
                     AND conrelid = to_regclass('public.quote_line_items')) THEN
    ALTER TABLE "public"."quote_line_items" ADD CONSTRAINT "fk_quote_line_items_quote_id_org" FOREIGN KEY (org_id, quote_id) REFERENCES "public"."quotes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quote_line_items_quote_id_org'
             AND conrelid = to_regclass('public.quote_line_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."quote_line_items" VALIDATE CONSTRAINT "fk_quote_line_items_quote_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_client_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_client_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_converted_invoice_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_converted_invoice_id_org" FOREIGN KEY (org_id, converted_invoice_id) REFERENCES "public"."invoices"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_converted_invoice_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_converted_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_deal_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_deal_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_candidate_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES "public"."candidates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_candidate_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_job_posting_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_job_posting_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_vendor_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES "public"."recruitment_vendors"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_vendor_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_payments_bill_id_org'
                     AND conrelid = to_regclass('public.vendor_payments')) THEN
    ALTER TABLE "public"."vendor_payments" ADD CONSTRAINT "fk_vendor_payments_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES "public"."purchase_bills"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_payments_bill_id_org'
             AND conrelid = to_regclass('public.vendor_payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_payments" VALIDATE CONSTRAINT "fk_vendor_payments_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_audit_events')) THEN
    ALTER TABLE "public"."sign_audit_events" ADD CONSTRAINT "fk_sign_audit_events_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_envelope_id_org'
             AND conrelid = to_regclass('public.sign_audit_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_audit_events" VALIDATE CONSTRAINT "fk_sign_audit_events_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_audit_events')) THEN
    ALTER TABLE "public"."sign_audit_events" ADD CONSTRAINT "fk_sign_audit_events_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES "public"."sign_recipients"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_recipient_id_org'
             AND conrelid = to_regclass('public.sign_audit_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_audit_events" VALIDATE CONSTRAINT "fk_sign_audit_events_recipient_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_jobs_template_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_jobs')) THEN
    ALTER TABLE "public"."sign_bulk_send_jobs" ADD CONSTRAINT "fk_sign_bulk_send_jobs_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."sign_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_jobs_template_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_jobs') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_jobs" VALIDATE CONSTRAINT "fk_sign_bulk_send_jobs_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_rows')) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" ADD CONSTRAINT "fk_sign_bulk_send_rows_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_envelope_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" VALIDATE CONSTRAINT "fk_sign_bulk_send_rows_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_job_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_rows')) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" ADD CONSTRAINT "fk_sign_bulk_send_rows_job_id_org" FOREIGN KEY (org_id, job_id) REFERENCES "public"."sign_bulk_send_jobs"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_job_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" VALIDATE CONSTRAINT "fk_sign_bulk_send_rows_job_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_certificates_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_certificates')) THEN
    ALTER TABLE "public"."sign_certificates" ADD CONSTRAINT "fk_sign_certificates_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_certificates_envelope_id_org'
             AND conrelid = to_regclass('public.sign_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_certificates" VALIDATE CONSTRAINT "fk_sign_certificates_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_documents_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_documents')) THEN
    ALTER TABLE "public"."sign_documents" ADD CONSTRAINT "fk_sign_documents_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_documents_envelope_id_org'
             AND conrelid = to_regclass('public.sign_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_documents" VALIDATE CONSTRAINT "fk_sign_documents_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_public_form_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_public_form_id_org" FOREIGN KEY (org_id, public_form_id) REFERENCES "public"."sign_public_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_public_form_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_public_form_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_template_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."sign_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_template_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_watermark_policy_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_watermark_policy_id_org" FOREIGN KEY (org_id, watermark_policy_id) REFERENCES "public"."sign_watermark_policies"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_watermark_policy_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_watermark_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_document_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES "public"."sign_documents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_document_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_envelope_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES "public"."sign_recipients"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_recipient_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_recipient_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_public_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_public_forms_template_id_org'
                     AND conrelid = to_regclass('public.sign_public_forms')) THEN
    ALTER TABLE "public"."sign_public_forms" ADD CONSTRAINT "fk_sign_public_forms_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."sign_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_public_forms_template_id_org'
             AND conrelid = to_regclass('public.sign_public_forms') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_public_forms" VALIDATE CONSTRAINT "fk_sign_public_forms_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_recipients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_recipients_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_recipients')) THEN
    ALTER TABLE "public"."sign_recipients" ADD CONSTRAINT "fk_sign_recipients_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_recipients_envelope_id_org'
             AND conrelid = to_regclass('public.sign_recipients') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_recipients" VALIDATE CONSTRAINT "fk_sign_recipients_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_signature_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_signature_assets')) THEN
    ALTER TABLE "public"."sign_signature_assets" ADD CONSTRAINT "fk_sign_signature_assets_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES "public"."sign_envelopes"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_envelope_id_org'
             AND conrelid = to_regclass('public.sign_signature_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_signature_assets" VALIDATE CONSTRAINT "fk_sign_signature_assets_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_signature_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_signature_assets')) THEN
    ALTER TABLE "public"."sign_signature_assets" ADD CONSTRAINT "fk_sign_signature_assets_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES "public"."sign_recipients"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_recipient_id_org'
             AND conrelid = to_regclass('public.sign_signature_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_signature_assets" VALIDATE CONSTRAINT "fk_sign_signature_assets_recipient_id_org";
  END IF;
END $$;
