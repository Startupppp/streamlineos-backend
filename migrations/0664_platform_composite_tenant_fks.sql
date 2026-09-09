-- =============================================================================
-- 0664 — Composite tenant foreign keys: workflow and platform
-- =============================================================================
-- Workflow, automation, AI and platform tables.
--
-- 20 composite tenant foreign keys.
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
  IF to_regclass('public.ai_chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_chat_messages_conversation_id_org'
                     AND conrelid = to_regclass('public.ai_chat_messages')) THEN
    ALTER TABLE "public"."ai_chat_messages" ADD CONSTRAINT "fk_ai_chat_messages_conversation_id_org" FOREIGN KEY (org_id, conversation_id) REFERENCES "public"."ai_chat_conversations"(org_id, id) NOT VALID;
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
  IF to_regclass('public.assignment_rule_state') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignment_rule_state_rule_id_org'
                     AND conrelid = to_regclass('public.assignment_rule_state')) THEN
    ALTER TABLE "public"."assignment_rule_state" ADD CONSTRAINT "fk_assignment_rule_state_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES "public"."lead_assignment_rules"(org_id, id) NOT VALID;
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
                     AND conrelid = to_regclass('public.automation_runs')) THEN
    ALTER TABLE "public"."automation_runs" ADD CONSTRAINT "fk_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES "public"."automation_rules"(org_id, id) NOT VALID;
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
  IF to_regclass('public.key_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_key_results_goal_id_org'
                     AND conrelid = to_regclass('public.key_results')) THEN
    ALTER TABLE "public"."key_results" ADD CONSTRAINT "fk_key_results_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES "public"."goals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_key_results_goal_id_org'
             AND conrelid = to_regclass('public.key_results') AND NOT convalidated) THEN
    ALTER TABLE "public"."key_results" VALIDATE CONSTRAINT "fk_key_results_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.module_setup_checklist_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_module_setup_checklist_items_checklist_id_org'
                     AND conrelid = to_regclass('public.module_setup_checklist_items')) THEN
    ALTER TABLE "public"."module_setup_checklist_items" ADD CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org" FOREIGN KEY (org_id, checklist_id) REFERENCES "public"."module_setup_checklists"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_module_setup_checklist_items_checklist_id_org'
             AND conrelid = to_regclass('public.module_setup_checklist_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."module_setup_checklist_items" VALIDATE CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.principal_group_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'principal_group_members_org_id_organization_membership_id_fkey'
                     AND conrelid = to_regclass('public.principal_group_members')) THEN
    ALTER TABLE "public"."principal_group_members" ADD CONSTRAINT "principal_group_members_org_id_organization_membership_id_fkey" FOREIGN KEY (org_id, organization_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'principal_group_members_org_id_organization_membership_id_fkey'
             AND conrelid = to_regclass('public.principal_group_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."principal_group_members" VALIDATE CONSTRAINT "principal_group_members_org_id_organization_membership_id_fkey";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.role_permission_grants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_permission_grants_role_id_org'
                     AND conrelid = to_regclass('public.role_permission_grants')) THEN
    ALTER TABLE "public"."role_permission_grants" ADD CONSTRAINT "fk_role_permission_grants_role_id_org" FOREIGN KEY (org_id, role_id) REFERENCES "public"."roles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_permission_grants_role_id_org'
             AND conrelid = to_regclass('public.role_permission_grants') AND NOT convalidated) THEN
    ALTER TABLE "public"."role_permission_grants" VALIDATE CONSTRAINT "fk_role_permission_grants_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.subscription_payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscription_payments_subscription_id_org'
                     AND conrelid = to_regclass('public.subscription_payments')) THEN
    ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "fk_subscription_payments_subscription_id_org" FOREIGN KEY (org_id, subscription_id) REFERENCES "public"."subscriptions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscription_payments_subscription_id_org'
             AND conrelid = to_regclass('public.subscription_payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."subscription_payments" VALIDATE CONSTRAINT "fk_subscription_payments_subscription_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.task_sequence_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_sequence_steps_sequence_id_org'
                     AND conrelid = to_regclass('public.task_sequence_steps')) THEN
    ALTER TABLE "public"."task_sequence_steps" ADD CONSTRAINT "fk_task_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES "public"."task_sequences"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_sequence_steps_sequence_id_org'
             AND conrelid = to_regclass('public.task_sequence_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."task_sequence_steps" VALIDATE CONSTRAINT "fk_task_sequence_steps_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_parent_task_id_org'
                     AND conrelid = to_regclass('public.tasks')) THEN
    ALTER TABLE "public"."tasks" ADD CONSTRAINT "fk_tasks_parent_task_id_org" FOREIGN KEY (org_id, parent_task_id) REFERENCES "public"."tasks"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_parent_task_id_org'
             AND conrelid = to_regclass('public.tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."tasks" VALIDATE CONSTRAINT "fk_tasks_parent_task_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.webhook_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_logs_endpoint_id_org'
                     AND conrelid = to_regclass('public.webhook_logs')) THEN
    ALTER TABLE "public"."webhook_logs" ADD CONSTRAINT "fk_webhook_logs_endpoint_id_org" FOREIGN KEY (org_id, endpoint_id) REFERENCES "public"."webhook_endpoints"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_logs_endpoint_id_org'
             AND conrelid = to_regclass('public.webhook_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."webhook_logs" VALIDATE CONSTRAINT "fk_webhook_logs_endpoint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_approvals')) THEN
    ALTER TABLE "public"."workflow_approvals" ADD CONSTRAINT "fk_workflow_approvals_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES "public"."workflow_executions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_execution_id_org'
             AND conrelid = to_regclass('public.workflow_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_approvals" VALIDATE CONSTRAINT "fk_workflow_approvals_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_step_id_org'
                     AND conrelid = to_regclass('public.workflow_approvals')) THEN
    ALTER TABLE "public"."workflow_approvals" ADD CONSTRAINT "fk_workflow_approvals_step_id_org" FOREIGN KEY (org_id, step_id) REFERENCES "public"."workflow_execution_steps"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_step_id_org'
             AND conrelid = to_regclass('public.workflow_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_approvals" VALIDATE CONSTRAINT "fk_workflow_approvals_step_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_audit_logs')) THEN
    ALTER TABLE "public"."workflow_audit_logs" ADD CONSTRAINT "fk_workflow_audit_logs_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES "public"."workflow_executions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_execution_id_org'
             AND conrelid = to_regclass('public.workflow_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_audit_logs" VALIDATE CONSTRAINT "fk_workflow_audit_logs_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_audit_logs')) THEN
    ALTER TABLE "public"."workflow_audit_logs" ADD CONSTRAINT "fk_workflow_audit_logs_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES "public"."workflows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_audit_logs" VALIDATE CONSTRAINT "fk_workflow_audit_logs_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_execution_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_execution_steps_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_execution_steps')) THEN
    ALTER TABLE "public"."workflow_execution_steps" ADD CONSTRAINT "fk_workflow_execution_steps_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES "public"."workflow_executions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_execution_steps_execution_id_org'
             AND conrelid = to_regclass('public.workflow_execution_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_execution_steps" VALIDATE CONSTRAINT "fk_workflow_execution_steps_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_executions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_executions')) THEN
    ALTER TABLE "public"."workflow_executions" ADD CONSTRAINT "fk_workflow_executions_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES "public"."workflows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_executions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_executions" VALIDATE CONSTRAINT "fk_workflow_executions_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_executions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_version_id_org'
                     AND conrelid = to_regclass('public.workflow_executions')) THEN
    ALTER TABLE "public"."workflow_executions" ADD CONSTRAINT "fk_workflow_executions_workflow_version_id_org" FOREIGN KEY (org_id, workflow_version_id) REFERENCES "public"."workflow_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_version_id_org'
             AND conrelid = to_regclass('public.workflow_executions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_executions" VALIDATE CONSTRAINT "fk_workflow_executions_workflow_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_schedules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_schedules_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_schedules')) THEN
    ALTER TABLE "public"."workflow_schedules" ADD CONSTRAINT "fk_workflow_schedules_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES "public"."workflows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_schedules_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_schedules') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_schedules" VALIDATE CONSTRAINT "fk_workflow_schedules_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_versions_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_versions')) THEN
    ALTER TABLE "public"."workflow_versions" ADD CONSTRAINT "fk_workflow_versions_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES "public"."workflows"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_versions_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_versions" VALIDATE CONSTRAINT "fk_workflow_versions_workflow_id_org";
  END IF;
END $$;
