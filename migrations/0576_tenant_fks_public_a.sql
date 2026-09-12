-- Composite tenant FKs, public schema, part 1 of 3.
--
-- Split by size, not by meaning: the purpose is identical across all four. §3 warns a ~2000-op monolith ECONNRESETs on Neon, and 635 constraints is ~1266 statements.
--
-- backend/CLAUDE.md §3: every tenant edge carries a composite tenant FK, and
-- "applied to the Neon branch" is not migrated. 635 of the 799 composite
-- same-tenant foreign keys on this database were applied by hand and exist in
-- no migration file, so a database rebuilt from migrations/ has no cross-tenant
-- referential integrity at all -- nothing stops a row referencing another
-- organisation's parent. This file authors 171 of them.
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
  IF to_regclass('public.acc_asset_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_asset_categories_accumulated_depreciation_account_id_org'
                     AND conrelid = to_regclass('public.acc_asset_categories'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_asset_categories'
             AND column_name = ANY (ARRAY['org_id', 'accumulated_depreciation_account_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "fk_acc_asset_categories_accumulated_depreciation_account_id_org" FOREIGN KEY (org_id, accumulated_depreciation_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
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
  IF to_regclass('public.acc_asset_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_asset_categories_asset_account_id_org'
                     AND conrelid = to_regclass('public.acc_asset_categories'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_asset_categories'
             AND column_name = ANY (ARRAY['org_id', 'asset_account_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "fk_acc_asset_categories_asset_account_id_org" FOREIGN KEY (org_id, asset_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_asset_categories_asset_account_id_org'
             AND conrelid = to_regclass('public.acc_asset_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_asset_categories" VALIDATE CONSTRAINT "fk_acc_asset_categories_asset_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_depreciation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_runs_journal_entry_id_org'
                     AND conrelid = to_regclass('public.acc_depreciation_runs'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_depreciation_runs'
             AND column_name = ANY (ARRAY['org_id', 'journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_depreciation_runs" ADD CONSTRAINT "fk_acc_depreciation_runs_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_runs_journal_entry_id_org'
             AND conrelid = to_regclass('public.acc_depreciation_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_depreciation_runs" VALIDATE CONSTRAINT "fk_acc_depreciation_runs_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_depreciation_schedules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_asset_id_org'
                     AND conrelid = to_regclass('public.acc_depreciation_schedules'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_depreciation_schedules'
             AND column_name = ANY (ARRAY['org_id', 'asset_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org" FOREIGN KEY (org_id, asset_id) REFERENCES acc_fixed_assets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_asset_id_org'
             AND conrelid = to_regclass('public.acc_depreciation_schedules') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_depreciation_schedules" VALIDATE CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_depreciation_schedules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_journal_entry_id_org'
                     AND conrelid = to_regclass('public.acc_depreciation_schedules'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_depreciation_schedules'
             AND column_name = ANY (ARRAY['org_id', 'journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_journal_entry_id_org'
             AND conrelid = to_regclass('public.acc_depreciation_schedules') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_depreciation_schedules" VALIDATE CONSTRAINT "fk_acc_depreciation_schedules_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_depreciation_schedules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_run_id_org'
                     AND conrelid = to_regclass('public.acc_depreciation_schedules'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_depreciation_schedules'
             AND column_name = ANY (ARRAY['org_id', 'run_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES acc_depreciation_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_depreciation_schedules_run_id_org'
             AND conrelid = to_regclass('public.acc_depreciation_schedules') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_depreciation_schedules" VALIDATE CONSTRAINT "fk_acc_depreciation_schedules_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_fixed_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_bill_id_org'
                     AND conrelid = to_regclass('public.acc_fixed_assets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_fixed_assets'
             AND column_name = ANY (ARRAY['org_id', 'bill_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_bill_id_org'
             AND conrelid = to_regclass('public.acc_fixed_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_fixed_assets" VALIDATE CONSTRAINT "fk_acc_fixed_assets_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_fixed_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_category_id_org'
                     AND conrelid = to_regclass('public.acc_fixed_assets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_fixed_assets'
             AND column_name = ANY (ARRAY['org_id', 'category_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES acc_asset_categories(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_category_id_org'
             AND conrelid = to_regclass('public.acc_fixed_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_fixed_assets" VALIDATE CONSTRAINT "fk_acc_fixed_assets_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_fixed_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_disposal_journal_entry_id_org'
                     AND conrelid = to_regclass('public.acc_fixed_assets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_fixed_assets'
             AND column_name = ANY (ARRAY['org_id', 'disposal_journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_disposal_journal_entry_id_org" FOREIGN KEY (org_id, disposal_journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_disposal_journal_entry_id_org'
             AND conrelid = to_regclass('public.acc_fixed_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_fixed_assets" VALIDATE CONSTRAINT "fk_acc_fixed_assets_disposal_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_fixed_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_vendor_id_org'
                     AND conrelid = to_regclass('public.acc_fixed_assets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_fixed_assets'
             AND column_name = ANY (ARRAY['org_id', 'vendor_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_fixed_assets_vendor_id_org'
             AND conrelid = to_regclass('public.acc_fixed_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_fixed_assets" VALIDATE CONSTRAINT "fk_acc_fixed_assets_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_system_account_map') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_system_account_map_account_id_org'
                     AND conrelid = to_regclass('public.acc_system_account_map'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_system_account_map'
             AND column_name = ANY (ARRAY['org_id', 'account_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_system_account_map" ADD CONSTRAINT "fk_acc_system_account_map_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_system_account_map_account_id_org'
             AND conrelid = to_regclass('public.acc_system_account_map') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_system_account_map" VALIDATE CONSTRAINT "fk_acc_system_account_map_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_tax_codes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_tax_codes_collected_account_id_org'
                     AND conrelid = to_regclass('public.acc_tax_codes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_tax_codes'
             AND column_name = ANY (ARRAY['org_id', 'collected_account_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_tax_codes" ADD CONSTRAINT "fk_acc_tax_codes_collected_account_id_org" FOREIGN KEY (org_id, collected_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_tax_codes_collected_account_id_org'
             AND conrelid = to_regclass('public.acc_tax_codes') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_tax_codes" VALIDATE CONSTRAINT "fk_acc_tax_codes_collected_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.acc_tax_payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_tax_payments_journal_entry_id_org'
                     AND conrelid = to_regclass('public.acc_tax_payments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'acc_tax_payments'
             AND column_name = ANY (ARRAY['org_id', 'journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."acc_tax_payments" ADD CONSTRAINT "fk_acc_tax_payments_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acc_tax_payments_journal_entry_id_org'
             AND conrelid = to_regclass('public.acc_tax_payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."acc_tax_payments" VALIDATE CONSTRAINT "fk_acc_tax_payments_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.accounting_dimension_values') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_dimension_values_dimension_id_org'
                     AND conrelid = to_regclass('public.accounting_dimension_values'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'accounting_dimension_values'
             AND column_name = ANY (ARRAY['org_id', 'dimension_id'])) = 2
    THEN
    ALTER TABLE "public"."accounting_dimension_values" ADD CONSTRAINT "fk_accounting_dimension_values_dimension_id_org" FOREIGN KEY (org_id, dimension_id) REFERENCES accounting_dimensions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_dimension_values_dimension_id_org'
             AND conrelid = to_regclass('public.accounting_dimension_values') AND NOT convalidated) THEN
    ALTER TABLE "public"."accounting_dimension_values" VALIDATE CONSTRAINT "fk_accounting_dimension_values_dimension_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.accounting_settings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_settings_retained_earnings_account_id_org'
                     AND conrelid = to_regclass('public.accounting_settings'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'accounting_settings'
             AND column_name = ANY (ARRAY['org_id', 'retained_earnings_account_id'])) = 2
    THEN
    ALTER TABLE "public"."accounting_settings" ADD CONSTRAINT "fk_accounting_settings_retained_earnings_account_id_org" FOREIGN KEY (org_id, retained_earnings_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounting_settings_retained_earnings_account_id_org'
             AND conrelid = to_regclass('public.accounting_settings') AND NOT convalidated) THEN
    ALTER TABLE "public"."accounting_settings" VALIDATE CONSTRAINT "fk_accounting_settings_retained_earnings_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.agent_tokens') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_tokens_issuer_membership'
                     AND conrelid = to_regclass('public.agent_tokens'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'agent_tokens'
             AND column_name = ANY (ARRAY['org_id', 'issuer_membership_id'])) = 2
    THEN
    ALTER TABLE "public"."agent_tokens" ADD CONSTRAINT "fk_agent_tokens_issuer_membership" FOREIGN KEY (org_id, issuer_membership_id) REFERENCES organization_members(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_tokens_issuer_membership'
             AND conrelid = to_regclass('public.agent_tokens') AND NOT convalidated) THEN
    ALTER TABLE "public"."agent_tokens" VALIDATE CONSTRAINT "fk_agent_tokens_issuer_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.ai_chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_chat_messages_conversation_id_org'
                     AND conrelid = to_regclass('public.ai_chat_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ai_chat_messages'
             AND column_name = ANY (ARRAY['org_id', 'conversation_id'])) = 2
    THEN
    ALTER TABLE "public"."ai_chat_messages" ADD CONSTRAINT "fk_ai_chat_messages_conversation_id_org" FOREIGN KEY (org_id, conversation_id) REFERENCES ai_chat_conversations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_chat_messages_conversation_id_org'
             AND conrelid = to_regclass('public.ai_chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."ai_chat_messages" VALIDATE CONSTRAINT "fk_ai_chat_messages_conversation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.announcement_reads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_reads_announcement_id_org'
                     AND conrelid = to_regclass('public.announcement_reads'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'announcement_reads'
             AND column_name = ANY (ARRAY['org_id', 'announcement_id'])) = 2
    THEN
    ALTER TABLE "public"."announcement_reads" ADD CONSTRAINT "fk_announcement_reads_announcement_id_org" FOREIGN KEY (org_id, announcement_id) REFERENCES announcements(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_reads_announcement_id_org'
             AND conrelid = to_regclass('public.announcement_reads') AND NOT convalidated) THEN
    ALTER TABLE "public"."announcement_reads" VALIDATE CONSTRAINT "fk_announcement_reads_announcement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.announcement_targets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_targets_announcement_id_org'
                     AND conrelid = to_regclass('public.announcement_targets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'announcement_targets'
             AND column_name = ANY (ARRAY['org_id', 'announcement_id'])) = 2
    THEN
    ALTER TABLE "public"."announcement_targets" ADD CONSTRAINT "fk_announcement_targets_announcement_id_org" FOREIGN KEY (org_id, announcement_id) REFERENCES announcements(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_targets_announcement_id_org'
             AND conrelid = to_regclass('public.announcement_targets') AND NOT convalidated) THEN
    ALTER TABLE "public"."announcement_targets" VALIDATE CONSTRAINT "fk_announcement_targets_announcement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assessment_attempts_assessment_id_org'
                     AND conrelid = to_regclass('public.assessment_attempts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'assessment_attempts'
             AND column_name = ANY (ARRAY['org_id', 'assessment_id'])) = 2
    THEN
    ALTER TABLE "public"."assessment_attempts" ADD CONSTRAINT "fk_assessment_attempts_assessment_id_org" FOREIGN KEY (org_id, assessment_id) REFERENCES skill_assessments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assessment_attempts_assessment_id_org'
             AND conrelid = to_regclass('public.assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."assessment_attempts" VALIDATE CONSTRAINT "fk_assessment_attempts_assessment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.asset_returns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_returns_asset_id_org'
                     AND conrelid = to_regclass('public.asset_returns'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'asset_returns'
             AND column_name = ANY (ARRAY['org_id', 'asset_id'])) = 2
    THEN
    ALTER TABLE "public"."asset_returns" ADD CONSTRAINT "fk_asset_returns_asset_id_org" FOREIGN KEY (org_id, asset_id) REFERENCES assets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_returns_asset_id_org'
             AND conrelid = to_regclass('public.asset_returns') AND NOT convalidated) THEN
    ALTER TABLE "public"."asset_returns" VALIDATE CONSTRAINT "fk_asset_returns_asset_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.assignment_rule_state') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignment_rule_state_rule_id_org'
                     AND conrelid = to_regclass('public.assignment_rule_state'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'assignment_rule_state'
             AND column_name = ANY (ARRAY['org_id', 'rule_id'])) = 2
    THEN
    ALTER TABLE "public"."assignment_rule_state" ADD CONSTRAINT "fk_assignment_rule_state_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES lead_assignment_rules(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignment_rule_state_rule_id_org'
             AND conrelid = to_regclass('public.assignment_rule_state') AND NOT convalidated) THEN
    ALTER TABLE "public"."assignment_rule_state" VALIDATE CONSTRAINT "fk_assignment_rule_state_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.automation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_automation_runs_rule_id_org'
                     AND conrelid = to_regclass('public.automation_runs'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'automation_runs'
             AND column_name = ANY (ARRAY['org_id', 'rule_id'])) = 2
    THEN
    ALTER TABLE "public"."automation_runs" ADD CONSTRAINT "fk_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES automation_rules(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_automation_runs_rule_id_org'
             AND conrelid = to_regclass('public.automation_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."automation_runs" VALIDATE CONSTRAINT "fk_automation_runs_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.biometric_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_biometric_logs_device_id_org'
                     AND conrelid = to_regclass('public.biometric_logs'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'biometric_logs'
             AND column_name = ANY (ARRAY['org_id', 'device_id'])) = 2
    THEN
    ALTER TABLE "public"."biometric_logs" ADD CONSTRAINT "fk_biometric_logs_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES biometric_devices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_biometric_logs_device_id_org'
             AND conrelid = to_regclass('public.biometric_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."biometric_logs" VALIDATE CONSTRAINT "fk_biometric_logs_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.booking_link_interviewers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_booking_link_interviewers_booking_link_id_org'
                     AND conrelid = to_regclass('public.booking_link_interviewers'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'booking_link_interviewers'
             AND column_name = ANY (ARRAY['org_id', 'booking_link_id'])) = 2
    THEN
    ALTER TABLE "public"."booking_link_interviewers" ADD CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org" FOREIGN KEY (org_id, booking_link_id) REFERENCES interview_booking_links(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_booking_link_interviewers_booking_link_id_org'
             AND conrelid = to_regclass('public.booking_link_interviewers') AND NOT convalidated) THEN
    ALTER TABLE "public"."booking_link_interviewers" VALIDATE CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_event_exceptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_event_exceptions_org_event'
                     AND conrelid = to_regclass('public.calendar_event_exceptions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calendar_event_exceptions'
             AND column_name = ANY (ARRAY['org_id', 'event_id'])) = 2
    THEN
    ALTER TABLE "public"."calendar_event_exceptions" ADD CONSTRAINT "fk_calendar_event_exceptions_org_event" FOREIGN KEY (org_id, event_id) REFERENCES calendar_events(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_event_exceptions_org_event'
             AND conrelid = to_regclass('public.calendar_event_exceptions') AND NOT convalidated) THEN
    ALTER TABLE "public"."calendar_event_exceptions" VALIDATE CONSTRAINT "fk_calendar_event_exceptions_org_event";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_linked_lead_party_id'
                     AND conrelid = to_regclass('public.calendar_events'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calendar_events'
             AND column_name = ANY (ARRAY['org_id', 'linked_lead_party_id'])) = 2
    THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead_party_id" FOREIGN KEY (org_id, linked_lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_linked_lead_party_id'
             AND conrelid = to_regclass('public.calendar_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."calendar_events" VALIDATE CONSTRAINT "fk_calendar_events_linked_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calendar_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_org_creator_membership'
                     AND conrelid = to_regclass('public.calendar_events'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calendar_events'
             AND column_name = ANY (ARRAY['org_id', 'created_by_membership_id'])) = 2
    THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_org_creator_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_events_org_creator_membership'
             AND conrelid = to_regclass('public.calendar_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."calendar_events" VALIDATE CONSTRAINT "fk_calendar_events_org_creator_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_participants_session_id_org'
                     AND conrelid = to_regclass('public.calibration_participants'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calibration_participants'
             AND column_name = ANY (ARRAY['org_id', 'session_id'])) = 2
    THEN
    ALTER TABLE "public"."calibration_participants" ADD CONSTRAINT "fk_calibration_participants_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES calibration_sessions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_participants_session_id_org'
             AND conrelid = to_regclass('public.calibration_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_participants" VALIDATE CONSTRAINT "fk_calibration_participants_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_candidate_id_org'
                     AND conrelid = to_regclass('public.calibration_sessions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calibration_sessions'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."calibration_sessions" ADD CONSTRAINT "fk_calibration_sessions_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_candidate_id_org'
             AND conrelid = to_regclass('public.calibration_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_sessions" VALIDATE CONSTRAINT "fk_calibration_sessions_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.calibration_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_job_posting_id_org'
                     AND conrelid = to_regclass('public.calibration_sessions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'calibration_sessions'
             AND column_name = ANY (ARRAY['org_id', 'job_posting_id'])) = 2
    THEN
    ALTER TABLE "public"."calibration_sessions" ADD CONSTRAINT "fk_calibration_sessions_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_calibration_sessions_job_posting_id_org'
             AND conrelid = to_regclass('public.calibration_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."calibration_sessions" VALIDATE CONSTRAINT "fk_calibration_sessions_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_applications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_applications'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_applications'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_applications" ADD CONSTRAINT "fk_candidate_applications_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_applications') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_applications" VALIDATE CONSTRAINT "fk_candidate_applications_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_applications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_applications'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_applications'
             AND column_name = ANY (ARRAY['org_id', 'job_posting_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_applications" ADD CONSTRAINT "fk_candidate_applications_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_applications_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_applications') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_applications" VALIDATE CONSTRAINT "fk_candidate_applications_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents_vault') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_vault_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_documents_vault'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_documents_vault'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_documents_vault" ADD CONSTRAINT "fk_candidate_documents_vault_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_vault_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_documents_vault') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents_vault" VALIDATE CONSTRAINT "fk_candidate_documents_vault_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_documents'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_documents'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_documents" ADD CONSTRAINT "fk_candidate_documents_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents" VALIDATE CONSTRAINT "fk_candidate_documents_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_template_id_org'
                     AND conrelid = to_regclass('public.candidate_documents'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_documents'
             AND column_name = ANY (ARRAY['org_id', 'template_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_documents" ADD CONSTRAINT "fk_candidate_documents_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES document_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_documents_template_id_org'
             AND conrelid = to_regclass('public.candidate_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_documents" VALIDATE CONSTRAINT "fk_candidate_documents_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_messages_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_messages'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_messages" ADD CONSTRAINT "fk_candidate_messages_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_messages_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_messages" VALIDATE CONSTRAINT "fk_candidate_messages_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_offers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_offers'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_offers'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_offers" ADD CONSTRAINT "fk_candidate_offers_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_offers') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_offers" VALIDATE CONSTRAINT "fk_candidate_offers_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_offers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_offers'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_offers'
             AND column_name = ANY (ARRAY['org_id', 'job_posting_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_offers" ADD CONSTRAINT "fk_candidate_offers_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_offers_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_offers') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_offers" VALIDATE CONSTRAINT "fk_candidate_offers_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_reference_checks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_reference_checks_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_reference_checks'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_reference_checks'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_reference_checks" ADD CONSTRAINT "fk_candidate_reference_checks_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_reference_checks_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_reference_checks') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_reference_checks" VALIDATE CONSTRAINT "fk_candidate_reference_checks_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_referrals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_referrals'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_referrals" ADD CONSTRAINT "fk_candidate_referrals_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_referrals" VALIDATE CONSTRAINT "fk_candidate_referrals_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_referrals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_job_posting_id_org'
                     AND conrelid = to_regclass('public.candidate_referrals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_referrals'
             AND column_name = ANY (ARRAY['org_id', 'job_posting_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_referrals" ADD CONSTRAINT "fk_candidate_referrals_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_referrals_job_posting_id_org'
             AND conrelid = to_regclass('public.candidate_referrals') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_referrals" VALIDATE CONSTRAINT "fk_candidate_referrals_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_resumes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_resumes_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_resumes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_resumes'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_resumes" ADD CONSTRAINT "fk_candidate_resumes_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_resumes_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_resumes') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_resumes" VALIDATE CONSTRAINT "fk_candidate_resumes_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidate_sla_tracking') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_sla_tracking_candidate_id_org'
                     AND conrelid = to_regclass('public.candidate_sla_tracking'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidate_sla_tracking'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."candidate_sla_tracking" ADD CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidate_sla_tracking_candidate_id_org'
             AND conrelid = to_regclass('public.candidate_sla_tracking') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidate_sla_tracking" VALIDATE CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.candidates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidates_duplicate_of_id_org'
                     AND conrelid = to_regclass('public.candidates'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'candidates'
             AND column_name = ANY (ARRAY['org_id', 'duplicate_of_id'])) = 2
    THEN
    ALTER TABLE "public"."candidates" ADD CONSTRAINT "fk_candidates_duplicate_of_id_org" FOREIGN KEY (org_id, duplicate_of_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_candidates_duplicate_of_id_org'
             AND conrelid = to_regclass('public.candidates') AND NOT convalidated) THEN
    ALTER TABLE "public"."candidates" VALIDATE CONSTRAINT "fk_candidates_duplicate_of_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_message_id_org'
                     AND conrelid = to_regclass('public.chat_attachments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_attachments'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_attachments" ADD CONSTRAINT "fk_chat_attachments_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_message_id_org'
             AND conrelid = to_regclass('public.chat_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_attachments" VALIDATE CONSTRAINT "fk_chat_attachments_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_org_message'
                     AND conrelid = to_regclass('public.chat_attachments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_attachments'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_attachments" ADD CONSTRAINT "fk_chat_attachments_org_message" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_attachments_org_message'
             AND conrelid = to_regclass('public.chat_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_attachments" VALIDATE CONSTRAINT "fk_chat_attachments_org_message";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_invite_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_invite_links_channel_id_org'
                     AND conrelid = to_regclass('public.chat_channel_invite_links'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channel_invite_links'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channel_invite_links" ADD CONSTRAINT "fk_chat_channel_invite_links_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_invite_links_channel_id_org'
             AND conrelid = to_regclass('public.chat_channel_invite_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_invite_links" VALIDATE CONSTRAINT "fk_chat_channel_invite_links_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_invite_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_invite_links_org_channel'
                     AND conrelid = to_regclass('public.chat_channel_invite_links'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channel_invite_links'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channel_invite_links" ADD CONSTRAINT "fk_chat_invite_links_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_invite_links_org_channel'
             AND conrelid = to_regclass('public.chat_channel_invite_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_invite_links" VALIDATE CONSTRAINT "fk_chat_invite_links_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_channel_id_org'
                     AND conrelid = to_regclass('public.chat_channel_members'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channel_members'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channel_members" ADD CONSTRAINT "fk_chat_channel_members_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_channel_id_org'
             AND conrelid = to_regclass('public.chat_channel_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_members" VALIDATE CONSTRAINT "fk_chat_channel_members_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channel_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_org_channel'
                     AND conrelid = to_regclass('public.chat_channel_members'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channel_members'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channel_members" ADD CONSTRAINT "fk_chat_channel_members_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channel_members_org_channel'
             AND conrelid = to_regclass('public.chat_channel_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channel_members" VALIDATE CONSTRAINT "fk_chat_channel_members_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_linked_deal_id_org'
                     AND conrelid = to_regclass('public.chat_channels'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channels'
             AND column_name = ANY (ARRAY['org_id', 'linked_deal_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channels" ADD CONSTRAINT "fk_chat_channels_linked_deal_id_org" FOREIGN KEY (org_id, linked_deal_id) REFERENCES deals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_linked_deal_id_org'
             AND conrelid = to_regclass('public.chat_channels') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_channels" VALIDATE CONSTRAINT "fk_chat_channels_linked_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_org_creator_membership'
                     AND conrelid = to_regclass('public.chat_channels'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_channels'
             AND column_name = ANY (ARRAY['org_id', 'created_by_membership_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_channels" ADD CONSTRAINT "fk_chat_channels_org_creator_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- fk_chat_channels_org_creator_membership is deliberately left NOT VALID: it is NOT VALID on the
-- source database, and WHY it was left that way is not established.
--
-- An earlier version of this comment said existing rows violate it. That was an
-- assumption, not a finding, and it is wrong as stated: there are zero violating
-- rows here. But that is not evidence the constraint holds either -- chat_channels,
-- chat_messages and kb_pages are all empty on this database, so zero violations
-- is entirely explained by zero rows, and nothing has been learned about real data.
--
-- So validating it here would succeed for a reason that says nothing, while the
-- same statement could fail on a populated database. Reproduce the source state
-- rather than improve on it. Whether these four can be validated is a decision
-- for the owners of chat and KB against data that exists; count the violations
-- first, with the FK columns' NULLs excluded.
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddle_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_huddle_id_org'
                     AND conrelid = to_regclass('public.chat_huddle_participants'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_huddle_participants'
             AND column_name = ANY (ARRAY['org_id', 'huddle_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_huddle_participants" ADD CONSTRAINT "fk_chat_huddle_participants_huddle_id_org" FOREIGN KEY (org_id, huddle_id) REFERENCES chat_huddles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_huddle_id_org'
             AND conrelid = to_regclass('public.chat_huddle_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddle_participants" VALIDATE CONSTRAINT "fk_chat_huddle_participants_huddle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddle_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_org_huddle'
                     AND conrelid = to_regclass('public.chat_huddle_participants'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_huddle_participants'
             AND column_name = ANY (ARRAY['org_id', 'huddle_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_huddle_participants" ADD CONSTRAINT "fk_chat_huddle_participants_org_huddle" FOREIGN KEY (org_id, huddle_id) REFERENCES chat_huddles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddle_participants_org_huddle'
             AND conrelid = to_regclass('public.chat_huddle_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddle_participants" VALIDATE CONSTRAINT "fk_chat_huddle_participants_org_huddle";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_channel_id_org'
                     AND conrelid = to_regclass('public.chat_huddles'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_huddles'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_huddles" ADD CONSTRAINT "fk_chat_huddles_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_channel_id_org'
             AND conrelid = to_regclass('public.chat_huddles') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddles" VALIDATE CONSTRAINT "fk_chat_huddles_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_huddles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_org_channel'
                     AND conrelid = to_regclass('public.chat_huddles'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_huddles'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_huddles" ADD CONSTRAINT "fk_chat_huddles_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_huddles_org_channel'
             AND conrelid = to_regclass('public.chat_huddles') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_huddles" VALIDATE CONSTRAINT "fk_chat_huddles_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_message_reactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_message_reactions_org_membership'
                     AND conrelid = to_regclass('public.chat_message_reactions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_message_reactions'
             AND column_name = ANY (ARRAY['org_id', 'membership_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_message_reactions" ADD CONSTRAINT "fk_chat_message_reactions_org_membership" FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_message_reactions_org_membership'
             AND conrelid = to_regclass('public.chat_message_reactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_message_reactions" VALIDATE CONSTRAINT "fk_chat_message_reactions_org_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_message_reactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_message_reactions_org_message'
                     AND conrelid = to_regclass('public.chat_message_reactions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_message_reactions'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_message_reactions" ADD CONSTRAINT "fk_chat_message_reactions_org_message" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_message_reactions_org_message'
             AND conrelid = to_regclass('public.chat_message_reactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_message_reactions" VALIDATE CONSTRAINT "fk_chat_message_reactions_org_message";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_channel_id_org'
                     AND conrelid = to_regclass('public.chat_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_messages'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_channel_id_org'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_channel'
                     AND conrelid = to_regclass('public.chat_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_messages'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_channel'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_sender_membership'
                     AND conrelid = to_regclass('public.chat_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_messages'
             AND column_name = ANY (ARRAY['org_id', 'sender_membership_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_org_sender_membership" FOREIGN KEY (org_id, sender_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- fk_chat_messages_org_sender_membership is deliberately left NOT VALID: it is NOT VALID on the
-- source database, and WHY it was left that way is not established.
--
-- An earlier version of this comment said existing rows violate it. That was an
-- assumption, not a finding, and it is wrong as stated: there are zero violating
-- rows here. But that is not evidence the constraint holds either -- chat_channels,
-- chat_messages and kb_pages are all empty on this database, so zero violations
-- is entirely explained by zero rows, and nothing has been learned about real data.
--
-- So validating it here would succeed for a reason that says nothing, while the
-- same statement could fail on a populated database. Reproduce the source state
-- rather than improve on it. Whether these four can be validated is a decision
-- for the owners of chat and KB against data that exists; count the violations
-- first, with the FK columns' NULLs excluded.
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_reply_to_id_org'
                     AND conrelid = to_regclass('public.chat_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_messages'
             AND column_name = ANY (ARRAY['org_id', 'reply_to_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_messages" ADD CONSTRAINT "fk_chat_messages_reply_to_id_org" FOREIGN KEY (org_id, reply_to_id) REFERENCES chat_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_reply_to_id_org'
             AND conrelid = to_regclass('public.chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_reply_to_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_channel_id_org'
                     AND conrelid = to_regclass('public.chat_pinned_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pinned_messages_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_channel_id_org'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pinned_messages_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_message_id_org'
                     AND conrelid = to_regclass('public.chat_pinned_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pinned_messages_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pinned_messages_message_id_org'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pinned_messages_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pins_org_channel'
                     AND conrelid = to_regclass('public.chat_pinned_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pins_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pins_org_channel'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pins_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_pinned_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pins_org_message'
                     AND conrelid = to_regclass('public.chat_pinned_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_pinned_messages" ADD CONSTRAINT "fk_chat_pins_org_message" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_pins_org_message'
             AND conrelid = to_regclass('public.chat_pinned_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_pinned_messages" VALIDATE CONSTRAINT "fk_chat_pins_org_message";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_channel_id_org'
                     AND conrelid = to_regclass('public.chat_reply_reminders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_channel_id_org'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_message_id_org'
                     AND conrelid = to_regclass('public.chat_reply_reminders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_message_id_org'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_org_channel'
                     AND conrelid = to_regclass('public.chat_reply_reminders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders'
             AND column_name = ANY (ARRAY['org_id', 'channel_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_org_channel" FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_org_channel'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_org_channel";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_reply_reminders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_org_message'
                     AND conrelid = to_regclass('public.chat_reply_reminders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_reply_reminders" ADD CONSTRAINT "fk_chat_reply_reminders_org_message" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_reply_reminders_org_message'
             AND conrelid = to_regclass('public.chat_reply_reminders') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_reply_reminders" VALIDATE CONSTRAINT "fk_chat_reply_reminders_org_message";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_saved_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_message_id_org'
                     AND conrelid = to_regclass('public.chat_saved_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_saved_messages'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_saved_messages" ADD CONSTRAINT "fk_chat_saved_messages_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_message_id_org'
             AND conrelid = to_regclass('public.chat_saved_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_saved_messages" VALIDATE CONSTRAINT "fk_chat_saved_messages_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chat_saved_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_org_message'
                     AND conrelid = to_regclass('public.chat_saved_messages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'chat_saved_messages'
             AND column_name = ANY (ARRAY['org_id', 'message_id'])) = 2
    THEN
    ALTER TABLE "public"."chat_saved_messages" ADD CONSTRAINT "fk_chat_saved_messages_org_message" FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_saved_messages_org_message'
             AND conrelid = to_regclass('public.chat_saved_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."chat_saved_messages" VALIDATE CONSTRAINT "fk_chat_saved_messages_org_message";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_account_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_account_activities_client_account_id_org'
                     AND conrelid = to_regclass('public.client_account_activities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_account_activities'
             AND column_name = ANY (ARRAY['org_id', 'client_account_id'])) = 2
    THEN
    ALTER TABLE "public"."client_account_activities" ADD CONSTRAINT "fk_client_account_activities_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES client_accounts(org_id, id) NOT VALID;
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
  IF to_regclass('public.client_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_accounts_lead_id_org'
                     AND conrelid = to_regclass('public.client_accounts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_accounts'
             AND column_name = ANY (ARRAY['org_id', 'lead_id'])) = 2
    THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_accounts_lead_id_org'
             AND conrelid = to_regclass('public.client_accounts') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_accounts" VALIDATE CONSTRAINT "fk_client_accounts_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_accounts_lead_party_id'
                     AND conrelid = to_regclass('public.client_accounts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_accounts'
             AND column_name = ANY (ARRAY['org_id', 'lead_party_id'])) = 2
    THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_accounts_lead_party_id'
             AND conrelid = to_regclass('public.client_accounts') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_accounts" VALIDATE CONSTRAINT "fk_client_accounts_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_health_scores') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_health_scores_client_account_id_org'
                     AND conrelid = to_regclass('public.client_health_scores'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_health_scores'
             AND column_name = ANY (ARRAY['org_id', 'client_account_id'])) = 2
    THEN
    ALTER TABLE "public"."client_health_scores" ADD CONSTRAINT "fk_client_health_scores_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES client_accounts(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_client_id_org'
                     AND conrelid = to_regclass('public.client_onboarding_items'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_onboarding_items'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_client_id_org'
             AND conrelid = to_regclass('public.client_onboarding_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_onboarding_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_client_party_id'
                     AND conrelid = to_regclass('public.client_onboarding_items'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_onboarding_items'
             AND column_name = ANY (ARRAY['org_id', 'client_party_id'])) = 2
    THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_client_party_id'
             AND conrelid = to_regclass('public.client_onboarding_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_onboarding_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_onboarding_items_template_id_org'
                     AND conrelid = to_regclass('public.client_onboarding_items'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_onboarding_items'
             AND column_name = ANY (ARRAY['org_id', 'template_id'])) = 2
    THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES client_onboarding_templates(org_id, id) NOT VALID;
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
  IF to_regclass('public.client_opportunities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_opportunities_client_id_org'
                     AND conrelid = to_regclass('public.client_opportunities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_opportunities'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_opportunities_client_id_org'
             AND conrelid = to_regclass('public.client_opportunities') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_opportunities" VALIDATE CONSTRAINT "fk_client_opportunities_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.client_opportunities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_opportunities_client_party_id'
                     AND conrelid = to_regclass('public.client_opportunities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_opportunities'
             AND column_name = ANY (ARRAY['org_id', 'client_party_id'])) = 2
    THEN
    ALTER TABLE "public"."client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_opportunities_client_party_id'
             AND conrelid = to_regclass('public.client_opportunities') AND NOT convalidated) THEN
    ALTER TABLE "public"."client_opportunities" VALIDATE CONSTRAINT "fk_client_opportunities_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.clients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_clients_lead_id_org'
                     AND conrelid = to_regclass('public.clients'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'clients'
             AND column_name = ANY (ARRAY['org_id', 'lead_id'])) = 2
    THEN
    ALTER TABLE "public"."clients" ADD CONSTRAINT "fk_clients_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_clients_lead_id_org'
             AND conrelid = to_regclass('public.clients') AND NOT convalidated) THEN
    ALTER TABLE "public"."clients" VALIDATE CONSTRAINT "fk_clients_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.commissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_deal_id_org'
                     AND conrelid = to_regclass('public.commissions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'commissions'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."commissions" ADD CONSTRAINT "fk_commissions_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_deal_id_org'
             AND conrelid = to_regclass('public.commissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."commissions" VALIDATE CONSTRAINT "fk_commissions_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.commissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_rule_id_org'
                     AND conrelid = to_regclass('public.commissions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'commissions'
             AND column_name = ANY (ARRAY['org_id', 'rule_id'])) = 2
    THEN
    ALTER TABLE "public"."commissions" ADD CONSTRAINT "fk_commissions_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES commission_rules(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_rule_id_org'
             AND conrelid = to_regclass('public.commissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."commissions" VALIDATE CONSTRAINT "fk_commissions_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.competencies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_competencies_framework_id_org'
                     AND conrelid = to_regclass('public.competencies'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'competencies'
             AND column_name = ANY (ARRAY['org_id', 'framework_id'])) = 2
    THEN
    ALTER TABLE "public"."competencies" ADD CONSTRAINT "fk_competencies_framework_id_org" FOREIGN KEY (org_id, framework_id) REFERENCES competency_frameworks(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_competencies_framework_id_org'
             AND conrelid = to_regclass('public.competencies') AND NOT convalidated) THEN
    ALTER TABLE "public"."competencies" VALIDATE CONSTRAINT "fk_competencies_framework_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.contacts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contacts_lead_id_org'
                     AND conrelid = to_regclass('public.contacts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'contacts'
             AND column_name = ANY (ARRAY['org_id', 'lead_id'])) = 2
    THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contacts_lead_id_org'
             AND conrelid = to_regclass('public.contacts') AND NOT convalidated) THEN
    ALTER TABLE "public"."contacts" VALIDATE CONSTRAINT "fk_contacts_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.contacts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contacts_organization_id_org'
                     AND conrelid = to_regclass('public.contacts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'contacts'
             AND column_name = ANY (ARRAY['org_id', 'organization_id'])) = 2
    THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_organization_id_org" FOREIGN KEY (org_id, organization_id) REFERENCES crm_organizations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contacts_organization_id_org'
             AND conrelid = to_regclass('public.contacts') AND NOT convalidated) THEN
    ALTER TABLE "public"."contacts" VALIDATE CONSTRAINT "fk_contacts_organization_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.credit_note_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_note_items_credit_note_id_org'
                     AND conrelid = to_regclass('public.credit_note_items'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'credit_note_items'
             AND column_name = ANY (ARRAY['org_id', 'credit_note_id'])) = 2
    THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "fk_credit_note_items_credit_note_id_org" FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_note_items_credit_note_id_org'
             AND conrelid = to_regclass('public.credit_note_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."credit_note_items" VALIDATE CONSTRAINT "fk_credit_note_items_credit_note_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.credit_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_notes_client_id_org'
                     AND conrelid = to_regclass('public.credit_notes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'credit_notes'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_notes_client_id_org'
             AND conrelid = to_regclass('public.credit_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."credit_notes" VALIDATE CONSTRAINT "fk_credit_notes_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.credit_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_notes_invoice_id_org'
                     AND conrelid = to_regclass('public.credit_notes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'credit_notes'
             AND column_name = ANY (ARRAY['org_id', 'invoice_id'])) = 2
    THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_credit_notes_invoice_id_org'
             AND conrelid = to_regclass('public.credit_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."credit_notes" VALIDATE CONSTRAINT "fk_credit_notes_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_activities_person_id_org'
                     AND conrelid = to_regclass('public.crm_activities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_activities'
             AND column_name = ANY (ARRAY['org_id', 'person_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_activities" ADD CONSTRAINT "fk_crm_activities_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES crm_people(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_automation_runs'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_automation_runs'
             AND column_name = ANY (ARRAY['org_id', 'rule_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_automation_runs" ADD CONSTRAINT "fk_crm_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES crm_automation_rules(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_blueprint_transitions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_blueprint_transitions'
             AND column_name = ANY (ARRAY['org_id', 'blueprint_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_blueprint_transitions" ADD CONSTRAINT "fk_crm_blueprint_transitions_blueprint_id_org" FOREIGN KEY (org_id, blueprint_id) REFERENCES crm_blueprints(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_blueprints'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_blueprints'
             AND column_name = ANY (ARRAY['org_id', 'pipeline_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_blueprints" ADD CONSTRAINT "fk_crm_blueprints_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES crm_pipelines(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_companies'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_companies'
             AND column_name = ANY (ARRAY['org_id', 'csm_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_companies" ADD CONSTRAINT "fk_crm_companies_csm_id_org" FOREIGN KEY (org_id, csm_id) REFERENCES crm_people(org_id, id) NOT VALID;
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
  IF to_regclass('public.crm_contact_channel_consent') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_channel_consent_contact_party_id'
                     AND conrelid = to_regclass('public.crm_contact_channel_consent'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_contact_channel_consent'
             AND column_name = ANY (ARRAY['org_id', 'contact_party_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_contact_channel_consent" ADD CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_channel_consent_contact_party_id'
             AND conrelid = to_regclass('public.crm_contact_channel_consent') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_contact_channel_consent" VALIDATE CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_contact_consent_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_consent_events_contact_party_id'
                     AND conrelid = to_regclass('public.crm_contact_consent_events'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_contact_consent_events'
             AND column_name = ANY (ARRAY['org_id', 'contact_party_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_contact_consent_events" ADD CONSTRAINT "fk_crm_contact_consent_events_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_consent_events_contact_party_id'
             AND conrelid = to_regclass('public.crm_contact_consent_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_contact_consent_events" VALIDATE CONSTRAINT "fk_crm_contact_consent_events_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_contact_roles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_roles_contact_id_org'
                     AND conrelid = to_regclass('public.crm_contact_roles'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_contact_roles'
             AND column_name = ANY (ARRAY['org_id', 'contact_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_roles_contact_id_org'
             AND conrelid = to_regclass('public.crm_contact_roles') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_contact_roles" VALIDATE CONSTRAINT "fk_crm_contact_roles_contact_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_contact_roles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_roles_contact_party_id'
                     AND conrelid = to_regclass('public.crm_contact_roles'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_contact_roles'
             AND column_name = ANY (ARRAY['org_id', 'contact_party_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_contact_roles_contact_party_id'
             AND conrelid = to_regclass('public.crm_contact_roles') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_contact_roles" VALIDATE CONSTRAINT "fk_crm_contact_roles_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deal_competitors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_competitors_deal_id_org'
                     AND conrelid = to_regclass('public.crm_deal_competitors'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_deal_competitors'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_deal_competitors" ADD CONSTRAINT "fk_crm_deal_competitors_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_contact_id_org'
                     AND conrelid = to_regclass('public.crm_deal_stakeholders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_deal_stakeholders'
             AND column_name = ANY (ARRAY['org_id', 'contact_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_contact_id_org'
             AND conrelid = to_regclass('public.crm_deal_stakeholders') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_deal_stakeholders" VALIDATE CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deal_stakeholders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_contact_party_id'
                     AND conrelid = to_regclass('public.crm_deal_stakeholders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_deal_stakeholders'
             AND column_name = ANY (ARRAY['org_id', 'contact_party_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_contact_party_id'
             AND conrelid = to_regclass('public.crm_deal_stakeholders') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_deal_stakeholders" VALIDATE CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_deal_stakeholders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_deal_stakeholders_deal_id_org'
                     AND conrelid = to_regclass('public.crm_deal_stakeholders'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_deal_stakeholders'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_deals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_deals'
             AND column_name = ANY (ARRAY['org_id', 'sales_rep_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_deals" ADD CONSTRAINT "fk_crm_deals_sales_rep_id_org" FOREIGN KEY (org_id, sales_rep_id) REFERENCES crm_people(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_lead_touchpoints'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_lead_touchpoints'
             AND column_name = ANY (ARRAY['org_id', 'campaign_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_campaign_id_org" FOREIGN KEY (org_id, campaign_id) REFERENCES crm_campaigns(org_id, id) NOT VALID;
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
  IF to_regclass('public.crm_lead_touchpoints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_lead_id_org'
                     AND conrelid = to_regclass('public.crm_lead_touchpoints'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_lead_touchpoints'
             AND column_name = ANY (ARRAY['org_id', 'lead_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_lead_id_org'
             AND conrelid = to_regclass('public.crm_lead_touchpoints') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_lead_touchpoints" VALIDATE CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_lead_touchpoints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_lead_party_id'
                     AND conrelid = to_regclass('public.crm_lead_touchpoints'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_lead_touchpoints'
             AND column_name = ANY (ARRAY['org_id', 'lead_party_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_lead_touchpoints_lead_party_id'
             AND conrelid = to_regclass('public.crm_lead_touchpoints') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_lead_touchpoints" VALIDATE CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_organizations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_organizations_parent_id_org'
                     AND conrelid = to_regclass('public.crm_organizations'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_organizations'
             AND column_name = ANY (ARRAY['org_id', 'parent_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_organizations" ADD CONSTRAINT "fk_crm_organizations_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES crm_organizations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_organizations_parent_id_org'
             AND conrelid = to_regclass('public.crm_organizations') AND NOT convalidated) THEN
    ALTER TABLE "public"."crm_organizations" VALIDATE CONSTRAINT "fk_crm_organizations_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.crm_pipeline_stages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_pipeline_stages_pipeline_id_org'
                     AND conrelid = to_regclass('public.crm_pipeline_stages'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_pipeline_stages'
             AND column_name = ANY (ARRAY['org_id', 'pipeline_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_pipeline_stages" ADD CONSTRAINT "fk_crm_pipeline_stages_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES crm_pipelines(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_pricebook_entries'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_pricebook_entries'
             AND column_name = ANY (ARRAY['org_id', 'pricebook_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_pricebook_entries" ADD CONSTRAINT "fk_crm_pricebook_entries_pricebook_id_org" FOREIGN KEY (org_id, pricebook_id) REFERENCES crm_pricebooks(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_pricebook_entries'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_pricebook_entries'
             AND column_name = ANY (ARRAY['org_id', 'product_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_pricebook_entries" ADD CONSTRAINT "fk_crm_pricebook_entries_product_id_org" FOREIGN KEY (org_id, product_id) REFERENCES crm_products(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_sequence_enrollments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_sequence_enrollments'
             AND column_name = ANY (ARRAY['org_id', 'sequence_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_sequence_enrollments" ADD CONSTRAINT "fk_crm_sequence_enrollments_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES crm_sequences(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_sequence_steps'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_sequence_steps'
             AND column_name = ANY (ARRAY['org_id', 'sequence_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_sequence_steps" ADD CONSTRAINT "fk_crm_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES crm_sequences(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_support_tickets'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_support_tickets'
             AND column_name = ANY (ARRAY['org_id', 'assignee_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_support_tickets" ADD CONSTRAINT "fk_crm_support_tickets_assignee_id_org" FOREIGN KEY (org_id, assignee_id) REFERENCES crm_people(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.crm_team_performance'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'crm_team_performance'
             AND column_name = ANY (ARRAY['org_id', 'person_id'])) = 2
    THEN
    ALTER TABLE "public"."crm_team_performance" ADD CONSTRAINT "fk_crm_team_performance_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES crm_people(org_id, id) NOT VALID;
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
  IF to_regclass('public.csat_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_survey_id_org'
                     AND conrelid = to_regclass('public.csat_responses'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'csat_responses'
             AND column_name = ANY (ARRAY['org_id', 'survey_id'])) = 2
    THEN
    ALTER TABLE "public"."csat_responses" ADD CONSTRAINT "fk_csat_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES csat_surveys(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_survey_id_org'
             AND conrelid = to_regclass('public.csat_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."csat_responses" VALIDATE CONSTRAINT "fk_csat_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.csat_surveys') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_surveys_client_id_org'
                     AND conrelid = to_regclass('public.csat_surveys'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'csat_surveys'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_surveys_client_id_org'
             AND conrelid = to_regclass('public.csat_surveys') AND NOT convalidated) THEN
    ALTER TABLE "public"."csat_surveys" VALIDATE CONSTRAINT "fk_csat_surveys_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.csat_surveys') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_surveys_client_party_id'
                     AND conrelid = to_regclass('public.csat_surveys'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'csat_surveys'
             AND column_name = ANY (ARRAY['org_id', 'client_party_id'])) = 2
    THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_surveys_client_party_id'
             AND conrelid = to_regclass('public.csat_surveys') AND NOT convalidated) THEN
    ALTER TABLE "public"."csat_surveys" VALIDATE CONSTRAINT "fk_csat_surveys_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deal_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deal_activities_deal_id_org'
                     AND conrelid = to_regclass('public.deal_activities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deal_activities'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."deal_activities" ADD CONSTRAINT "fk_deal_activities_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.deal_approvals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deal_approvals'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."deal_approvals" ADD CONSTRAINT "fk_deal_approvals_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.deal_meeting_attendees'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deal_meeting_attendees'
             AND column_name = ANY (ARRAY['org_id', 'meeting_id'])) = 2
    THEN
    ALTER TABLE "public"."deal_meeting_attendees" ADD CONSTRAINT "fk_deal_meeting_attendees_meeting_id_org" FOREIGN KEY (org_id, meeting_id) REFERENCES deal_meetings(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.deal_meetings'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deal_meetings'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."deal_meetings" ADD CONSTRAINT "fk_deal_meetings_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_client_id_org'
                     AND conrelid = to_regclass('public.deals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deals'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_client_id_org'
             AND conrelid = to_regclass('public.deals') AND NOT convalidated) THEN
    ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_lead_id_org'
                     AND conrelid = to_regclass('public.deals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deals'
             AND column_name = ANY (ARRAY['org_id', 'lead_id'])) = 2
    THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_lead_id_org'
             AND conrelid = to_regclass('public.deals') AND NOT convalidated) THEN
    ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_lead_party_id'
                     AND conrelid = to_regclass('public.deals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deals'
             AND column_name = ANY (ARRAY['org_id', 'lead_party_id'])) = 2
    THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_lead_party_id'
             AND conrelid = to_regclass('public.deals') AND NOT convalidated) THEN
    ALTER TABLE "public"."deals" VALIDATE CONSTRAINT "fk_deals_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.deals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_deals_pipeline_id_org'
                     AND conrelid = to_regclass('public.deals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'deals'
             AND column_name = ANY (ARRAY['org_id', 'pipeline_id'])) = 2
    THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_pipeline_id_org" FOREIGN KEY (org_id, pipeline_id) REFERENCES crm_pipelines(org_id, id) NOT VALID;
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
  IF to_regclass('public.document_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_audit_logs_onboarding_document_id_org'
                     AND conrelid = to_regclass('public.document_audit_logs'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'document_audit_logs'
             AND column_name = ANY (ARRAY['org_id', 'onboarding_document_id'])) = 2
    THEN
    ALTER TABLE "public"."document_audit_logs" ADD CONSTRAINT "fk_document_audit_logs_onboarding_document_id_org" FOREIGN KEY (org_id, onboarding_document_id) REFERENCES onboarding_documents(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_audit_logs_onboarding_document_id_org'
             AND conrelid = to_regclass('public.document_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."document_audit_logs" VALIDATE CONSTRAINT "fk_document_audit_logs_onboarding_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_template_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_template_versions_template_id_org'
                     AND conrelid = to_regclass('public.document_template_versions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'document_template_versions'
             AND column_name = ANY (ARRAY['org_id', 'template_id'])) = 2
    THEN
    ALTER TABLE "public"."document_template_versions" ADD CONSTRAINT "fk_document_template_versions_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES document_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_template_versions_template_id_org'
             AND conrelid = to_regclass('public.document_template_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."document_template_versions" VALIDATE CONSTRAINT "fk_document_template_versions_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_parent_document_id_org'
                     AND conrelid = to_regclass('public.documents'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'documents'
             AND column_name = ANY (ARRAY['org_id', 'parent_document_id'])) = 2
    THEN
    ALTER TABLE "public"."documents" ADD CONSTRAINT "fk_documents_parent_document_id_org" FOREIGN KEY (org_id, parent_document_id) REFERENCES documents(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_parent_document_id_org'
             AND conrelid = to_regclass('public.documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."documents" VALIDATE CONSTRAINT "fk_documents_parent_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_candidate_id_org'
                     AND conrelid = to_regclass('public.email_sequence_enrollments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'email_sequence_enrollments'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."email_sequence_enrollments" ADD CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_candidate_id_org'
             AND conrelid = to_regclass('public.email_sequence_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_enrollments" VALIDATE CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_sequence_id_org'
                     AND conrelid = to_regclass('public.email_sequence_enrollments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'email_sequence_enrollments'
             AND column_name = ANY (ARRAY['org_id', 'sequence_id'])) = 2
    THEN
    ALTER TABLE "public"."email_sequence_enrollments" ADD CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES email_sequences(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_enrollments_sequence_id_org'
             AND conrelid = to_regclass('public.email_sequence_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_enrollments" VALIDATE CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.email_sequence_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_steps_sequence_id_org'
                     AND conrelid = to_regclass('public.email_sequence_steps'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'email_sequence_steps'
             AND column_name = ANY (ARRAY['org_id', 'sequence_id'])) = 2
    THEN
    ALTER TABLE "public"."email_sequence_steps" ADD CONSTRAINT "fk_email_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES email_sequences(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_email_sequence_steps_sequence_id_org'
             AND conrelid = to_regclass('public.email_sequence_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."email_sequence_steps" VALIDATE CONSTRAINT "fk_email_sequence_steps_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_career_plans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_career_plans_path_id_org'
                     AND conrelid = to_regclass('public.employee_career_plans'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'employee_career_plans'
             AND column_name = ANY (ARRAY['org_id', 'path_id'])) = 2
    THEN
    ALTER TABLE "public"."employee_career_plans" ADD CONSTRAINT "fk_employee_career_plans_path_id_org" FOREIGN KEY (org_id, path_id) REFERENCES career_paths(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_career_plans_path_id_org'
             AND conrelid = to_regclass('public.employee_career_plans') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_career_plans" VALIDATE CONSTRAINT "fk_employee_career_plans_path_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_salary_profile_components') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_component_id_org'
                     AND conrelid = to_regclass('public.employee_salary_profile_components'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'employee_salary_profile_components'
             AND column_name = ANY (ARRAY['org_id', 'component_id'])) = 2
    THEN
    ALTER TABLE "public"."employee_salary_profile_components" ADD CONSTRAINT "fk_employee_salary_profile_components_component_id_org" FOREIGN KEY (org_id, component_id) REFERENCES salary_components(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_component_id_org'
             AND conrelid = to_regclass('public.employee_salary_profile_components') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_salary_profile_components" VALIDATE CONSTRAINT "fk_employee_salary_profile_components_component_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_salary_profile_components') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_profile_id_org'
                     AND conrelid = to_regclass('public.employee_salary_profile_components'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'employee_salary_profile_components'
             AND column_name = ANY (ARRAY['org_id', 'profile_id'])) = 2
    THEN
    ALTER TABLE "public"."employee_salary_profile_components" ADD CONSTRAINT "fk_employee_salary_profile_components_profile_id_org" FOREIGN KEY (org_id, profile_id) REFERENCES employee_salary_profiles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_profile_id_org'
             AND conrelid = to_regclass('public.employee_salary_profile_components') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_salary_profile_components" VALIDATE CONSTRAINT "fk_employee_salary_profile_components_profile_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_shift_assignments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_shift_assignments_shift_id_org'
                     AND conrelid = to_regclass('public.employee_shift_assignments'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'employee_shift_assignments'
             AND column_name = ANY (ARRAY['org_id', 'shift_id'])) = 2
    THEN
    ALTER TABLE "public"."employee_shift_assignments" ADD CONSTRAINT "fk_employee_shift_assignments_shift_id_org" FOREIGN KEY (org_id, shift_id) REFERENCES shift_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_shift_assignments_shift_id_org'
             AND conrelid = to_regclass('public.employee_shift_assignments') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_shift_assignments" VALIDATE CONSTRAINT "fk_employee_shift_assignments_shift_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.enterprise_quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enterprise_quotes_client_id_org'
                     AND conrelid = to_regclass('public.enterprise_quotes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'enterprise_quotes'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."enterprise_quotes" ADD CONSTRAINT "fk_enterprise_quotes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES client_accounts(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.enterprise_quotes'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'enterprise_quotes'
             AND column_name = ANY (ARRAY['org_id', 'deal_id'])) = 2
    THEN
    ALTER TABLE "public"."enterprise_quotes" ADD CONSTRAINT "fk_enterprise_quotes_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
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
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_event_id_org'
                     AND conrelid = to_regclass('public.event_attendees'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'event_attendees'
             AND column_name = ANY (ARRAY['org_id', 'event_id'])) = 2
    THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES calendar_events(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_event_id_org'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_event_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_event'
                     AND conrelid = to_regclass('public.event_attendees'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'event_attendees'
             AND column_name = ANY (ARRAY['org_id', 'event_id'])) = 2
    THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_org_event" FOREIGN KEY (org_id, event_id) REFERENCES calendar_events(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_event'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_org_event";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_membership'
                     AND conrelid = to_regclass('public.event_attendees'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'event_attendees'
             AND column_name = ANY (ARRAY['org_id', 'membership_id'])) = 2
    THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_org_membership" FOREIGN KEY (org_id, membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_membership'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_org_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.event_attendees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_user'
                     AND conrelid = to_regclass('public.event_attendees'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'event_attendees'
             AND column_name = ANY (ARRAY['org_id', 'user_id'])) = 2
    THEN
    ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "fk_event_attendees_org_user" FOREIGN KEY (org_id, user_id) REFERENCES organization_members(org_id, user_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_event_attendees_org_user'
             AND conrelid = to_regclass('public.event_attendees') AND NOT convalidated) THEN
    ALTER TABLE "public"."event_attendees" VALIDATE CONSTRAINT "fk_event_attendees_org_user";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.exit_checklists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_exit_checklists_resignation_id_org'
                     AND conrelid = to_regclass('public.exit_checklists'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'exit_checklists'
             AND column_name = ANY (ARRAY['org_id', 'resignation_id'])) = 2
    THEN
    ALTER TABLE "public"."exit_checklists" ADD CONSTRAINT "fk_exit_checklists_resignation_id_org" FOREIGN KEY (org_id, resignation_id) REFERENCES resignations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_exit_checklists_resignation_id_org'
             AND conrelid = to_regclass('public.exit_checklists') AND NOT convalidated) THEN
    ALTER TABLE "public"."exit_checklists" VALIDATE CONSTRAINT "fk_exit_checklists_resignation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expense_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expense_categories_ledger_account_id_org'
                     AND conrelid = to_regclass('public.expense_categories'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'expense_categories'
             AND column_name = ANY (ARRAY['org_id', 'ledger_account_id'])) = 2
    THEN
    ALTER TABLE "public"."expense_categories" ADD CONSTRAINT "fk_expense_categories_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expense_categories_ledger_account_id_org'
             AND conrelid = to_regclass('public.expense_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."expense_categories" VALIDATE CONSTRAINT "fk_expense_categories_ledger_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expenses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_approver_actor'
                     AND conrelid = to_regclass('public.expenses'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'expenses'
             AND column_name = ANY (ARRAY['org_id', 'approver_membership_id'])) = 2
    THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_approver_actor" FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_approver_actor'
             AND conrelid = to_regclass('public.expenses') AND NOT convalidated) THEN
    ALTER TABLE "public"."expenses" VALIDATE CONSTRAINT "fk_expenses_approver_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expenses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_category_id_org'
                     AND conrelid = to_regclass('public.expenses'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'expenses'
             AND column_name = ANY (ARRAY['org_id', 'category_id'])) = 2
    THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES expense_categories(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_posted_journal_entry_id_org'
                     AND conrelid = to_regclass('public.expenses'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'expenses'
             AND column_name = ANY (ARRAY['org_id', 'posted_journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_posted_journal_entry_id_org" FOREIGN KEY (org_id, posted_journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_posted_journal_entry_id_org'
             AND conrelid = to_regclass('public.expenses') AND NOT convalidated) THEN
    ALTER TABLE "public"."expenses" VALIDATE CONSTRAINT "fk_expenses_posted_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.expenses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_project_id_org'
                     AND conrelid = to_regclass('public.expenses'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'expenses'
             AND column_name = ANY (ARRAY['org_id', 'project_id'])) = 2
    THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.external_referrals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'external_referrals'
             AND column_name = ANY (ARRAY['org_id', 'candidate_id'])) = 2
    THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.external_referrals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'external_referrals'
             AND column_name = ANY (ARRAY['org_id', 'job_posting_id'])) = 2
    THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.external_referrals'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'external_referrals'
             AND column_name = ANY (ARRAY['org_id', 'referrer_id'])) = 2
    THEN
    ALTER TABLE "public"."external_referrals" ADD CONSTRAINT "fk_external_referrals_referrer_id_org" FOREIGN KEY (org_id, referrer_id) REFERENCES external_referrers(org_id, id) NOT VALID;
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
  IF to_regclass('public.feedback_cycle_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_cycle_requests_cycle_id_org'
                     AND conrelid = to_regclass('public.feedback_cycle_requests'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'feedback_cycle_requests'
             AND column_name = ANY (ARRAY['org_id', 'cycle_id'])) = 2
    THEN
    ALTER TABLE "public"."feedback_cycle_requests" ADD CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES feedback_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_cycle_requests_cycle_id_org'
             AND conrelid = to_regclass('public.feedback_cycle_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."feedback_cycle_requests" VALIDATE CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.feedback_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_requests_cycle_id_org'
                     AND conrelid = to_regclass('public.feedback_requests'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'feedback_requests'
             AND column_name = ANY (ARRAY['org_id', 'cycle_id'])) = 2
    THEN
    ALTER TABLE "public"."feedback_requests" ADD CONSTRAINT "fk_feedback_requests_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES review_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_requests_cycle_id_org'
             AND conrelid = to_regclass('public.feedback_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."feedback_requests" VALIDATE CONSTRAINT "fk_feedback_requests_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_accounts_ledger_account_id_org'
                     AND conrelid = to_regclass('public.fin_bank_accounts'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_accounts'
             AND column_name = ANY (ARRAY['org_id', 'ledger_account_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_accounts" ADD CONSTRAINT "fk_fin_bank_accounts_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_accounts_ledger_account_id_org'
             AND conrelid = to_regclass('public.fin_bank_accounts') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_accounts" VALIDATE CONSTRAINT "fk_fin_bank_accounts_ledger_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_imports') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_imports_bank_account_id_org'
                     AND conrelid = to_regclass('public.fin_bank_imports'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_imports'
             AND column_name = ANY (ARRAY['org_id', 'bank_account_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_imports" ADD CONSTRAINT "fk_fin_bank_imports_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_imports_bank_account_id_org'
             AND conrelid = to_regclass('public.fin_bank_imports') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_imports" VALIDATE CONSTRAINT "fk_fin_bank_imports_bank_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_bank_account_id_org'
                     AND conrelid = to_regclass('public.fin_bank_transactions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_transactions'
             AND column_name = ANY (ARRAY['org_id', 'bank_account_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_bank_account_id_org'
             AND conrelid = to_regclass('public.fin_bank_transactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_transactions" VALIDATE CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_import_id_org'
                     AND conrelid = to_regclass('public.fin_bank_transactions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_transactions'
             AND column_name = ANY (ARRAY['org_id', 'import_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_import_id_org" FOREIGN KEY (org_id, import_id) REFERENCES fin_bank_imports(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_import_id_org'
             AND conrelid = to_regclass('public.fin_bank_transactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_transactions" VALIDATE CONSTRAINT "fk_fin_bank_transactions_import_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_matched_journal_entry_id_org'
                     AND conrelid = to_regclass('public.fin_bank_transactions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_transactions'
             AND column_name = ANY (ARRAY['org_id', 'matched_journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_matched_journal_entry_id_org" FOREIGN KEY (org_id, matched_journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transactions_matched_journal_entry_id_org'
             AND conrelid = to_regclass('public.fin_bank_transactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_transactions" VALIDATE CONSTRAINT "fk_fin_bank_transactions_matched_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_transfers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transfers_from_bank_account_id_org'
                     AND conrelid = to_regclass('public.fin_bank_transfers'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_transfers'
             AND column_name = ANY (ARRAY['org_id', 'from_bank_account_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_from_bank_account_id_org" FOREIGN KEY (org_id, from_bank_account_id) REFERENCES fin_bank_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transfers_from_bank_account_id_org'
             AND conrelid = to_regclass('public.fin_bank_transfers') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_transfers" VALIDATE CONSTRAINT "fk_fin_bank_transfers_from_bank_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_bank_transfers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transfers_journal_entry_id_org'
                     AND conrelid = to_regclass('public.fin_bank_transfers'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_bank_transfers'
             AND column_name = ANY (ARRAY['org_id', 'journal_entry_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_bank_transfers_journal_entry_id_org'
             AND conrelid = to_regclass('public.fin_bank_transfers') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_bank_transfers" VALIDATE CONSTRAINT "fk_fin_bank_transfers_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_budget_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_account_id_org'
                     AND conrelid = to_regclass('public.fin_budget_lines'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_budget_lines'
             AND column_name = ANY (ARRAY['org_id', 'account_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_account_id_org'
             AND conrelid = to_regclass('public.fin_budget_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_budget_lines" VALIDATE CONSTRAINT "fk_fin_budget_lines_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_budget_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_budget_id_org'
                     AND conrelid = to_regclass('public.fin_budget_lines'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_budget_lines'
             AND column_name = ANY (ARRAY['org_id', 'budget_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_budget_id_org'
             AND conrelid = to_regclass('public.fin_budget_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_budget_lines" VALIDATE CONSTRAINT "fk_fin_budget_lines_budget_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_budget_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_project_id_org'
                     AND conrelid = to_regclass('public.fin_budget_lines'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_budget_lines'
             AND column_name = ANY (ARRAY['org_id', 'project_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_lines_project_id_org'
             AND conrelid = to_regclass('public.fin_budget_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_budget_lines" VALIDATE CONSTRAINT "fk_fin_budget_lines_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_budget_revisions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_revisions_budget_id_org'
                     AND conrelid = to_regclass('public.fin_budget_revisions'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_budget_revisions'
             AND column_name = ANY (ARRAY['org_id', 'budget_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_budget_revisions" ADD CONSTRAINT "fk_fin_budget_revisions_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_budget_revisions_budget_id_org'
             AND conrelid = to_regclass('public.fin_budget_revisions') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_budget_revisions" VALIDATE CONSTRAINT "fk_fin_budget_revisions_budget_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_collection_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_collection_activities_client_id_org'
                     AND conrelid = to_regclass('public.fin_collection_activities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_collection_activities'
             AND column_name = ANY (ARRAY['org_id', 'client_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_collection_activities_client_id_org'
             AND conrelid = to_regclass('public.fin_collection_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_collection_activities" VALIDATE CONSTRAINT "fk_fin_collection_activities_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_collection_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_collection_activities_invoice_id_org'
                     AND conrelid = to_regclass('public.fin_collection_activities'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_collection_activities'
             AND column_name = ANY (ARRAY['org_id', 'invoice_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_collection_activities_invoice_id_org'
             AND conrelid = to_regclass('public.fin_collection_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_collection_activities" VALIDATE CONSTRAINT "fk_fin_collection_activities_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_expense_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_policies_category_id_org'
                     AND conrelid = to_regclass('public.fin_expense_policies'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_expense_policies'
             AND column_name = ANY (ARRAY['org_id', 'category_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fk_fin_expense_policies_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES expense_categories(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_expense_policies_category_id_org'
             AND conrelid = to_regclass('public.fin_expense_policies') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_expense_policies" VALIDATE CONSTRAINT "fk_fin_expense_policies_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_payment_allocations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_allocations_invoice_id_org'
                     AND conrelid = to_regclass('public.fin_payment_allocations'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_payment_allocations'
             AND column_name = ANY (ARRAY['org_id', 'invoice_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_allocations_invoice_id_org'
             AND conrelid = to_regclass('public.fin_payment_allocations') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_allocations" VALIDATE CONSTRAINT "fk_fin_payment_allocations_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_payment_allocations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_allocations_payment_id_org'
                     AND conrelid = to_regclass('public.fin_payment_allocations'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_payment_allocations'
             AND column_name = ANY (ARRAY['org_id', 'payment_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_payment_id_org" FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_allocations_payment_id_org'
             AND conrelid = to_regclass('public.fin_payment_allocations') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_allocations" VALIDATE CONSTRAINT "fk_fin_payment_allocations_payment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_payment_run_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_bill_id_org'
                     AND conrelid = to_regclass('public.fin_payment_run_items'))
     AND (SELECT count(DISTINCT column_name) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'fin_payment_run_items'
             AND column_name = ANY (ARRAY['org_id', 'bill_id'])) = 2
    THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_bill_id_org'
             AND conrelid = to_regclass('public.fin_payment_run_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_run_items" VALIDATE CONSTRAINT "fk_fin_payment_run_items_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
