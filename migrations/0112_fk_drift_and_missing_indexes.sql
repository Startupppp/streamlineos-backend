-- Final FK drift cleanup + missing FK index pass.
-- 1) Add FK constraints that exist in schema TS but not in DB.
-- 2) Add real cross-table FK constraints on "*_id" integer columns that lacked them.
-- 3) Add indexes for FK columns (performance: required for fast joins / parent deletes).
-- 4) Add idx_<table>_org for tables that had an org_id column but no index on it.

------------------------------------------------------------------------------
-- 1. FK constraints declared in schema TS but missing in DB
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tickets_state_id_fk') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_state_id_fk
      FOREIGN KEY (state_id) REFERENCES custom_states(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tickets_module_id_fk') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_module_id_fk
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tickets_cycle_id_fk') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_cycle_id_fk
      FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE SET NULL;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. New FK constraints to close integrity gaps
------------------------------------------------------------------------------
-- candidate_documents.candidate_id -> candidates(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='candidate_documents_candidate_id_fk') THEN
    UPDATE candidate_documents SET candidate_id = NULL
      WHERE candidate_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM candidates WHERE id = candidate_documents.candidate_id);
    ALTER TABLE candidate_documents ADD CONSTRAINT candidate_documents_candidate_id_fk
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE;
  END IF;
END $$;

-- candidate_documents_vault.candidate_id -> candidates(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='candidate_documents_vault_candidate_id_fk') THEN
    DELETE FROM candidate_documents_vault
      WHERE NOT EXISTS (SELECT 1 FROM candidates WHERE id = candidate_documents_vault.candidate_id);
    ALTER TABLE candidate_documents_vault ADD CONSTRAINT candidate_documents_vault_candidate_id_fk
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE;
  END IF;
END $$;

-- candidates.duplicate_of_id (self-ref) -> candidates(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='candidates_duplicate_of_id_fk') THEN
    UPDATE candidates SET duplicate_of_id = NULL
      WHERE duplicate_of_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM candidates c2 WHERE c2.id = candidates.duplicate_of_id);
    ALTER TABLE candidates ADD CONSTRAINT candidates_duplicate_of_id_fk
      FOREIGN KEY (duplicate_of_id) REFERENCES candidates(id) ON DELETE SET NULL;
  END IF;
END $$;

-- tasks.parent_task_id (self-ref) -> tasks(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_parent_task_id_fk') THEN
    UPDATE tasks SET parent_task_id = NULL
      WHERE parent_task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.id = tasks.parent_task_id);
    ALTER TABLE tasks ADD CONSTRAINT tasks_parent_task_id_fk
      FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL;
  END IF;
END $$;

-- projects.deal_id -> deals(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='projects_deal_id_fk') THEN
    UPDATE projects SET deal_id = NULL
      WHERE deal_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM deals WHERE id = projects.deal_id);
    ALTER TABLE projects ADD CONSTRAINT projects_deal_id_fk
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
  END IF;
END $$;

-- targets.branch_id -> branches(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_branch_id_fk') THEN
    UPDATE targets SET branch_id = NULL
      WHERE branch_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM branches WHERE id = targets.branch_id);
    ALTER TABLE targets ADD CONSTRAINT targets_branch_id_fk
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- onboarding_templates.department_id -> departments(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='onboarding_templates_department_id_fk') THEN
    UPDATE onboarding_templates SET department_id = NULL
      WHERE department_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM departments WHERE id = onboarding_templates.department_id);
    ALTER TABLE onboarding_templates ADD CONSTRAINT onboarding_templates_department_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- calendar_events.linked_lead_id -> leads(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_linked_lead_id_fk') THEN
    UPDATE calendar_events SET linked_lead_id = NULL
      WHERE linked_lead_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM leads WHERE id = calendar_events.linked_lead_id);
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_linked_lead_id_fk
      FOREIGN KEY (linked_lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
END $$;

-- calendar_events.linked_deal_id -> deals(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_events_linked_deal_id_fk') THEN
    UPDATE calendar_events SET linked_deal_id = NULL
      WHERE linked_deal_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM deals WHERE id = calendar_events.linked_deal_id);
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_linked_deal_id_fk
      FOREIGN KEY (linked_deal_id) REFERENCES deals(id) ON DELETE SET NULL;
  END IF;
END $$;

-- users.department_id -> departments(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_department_id_fk') THEN
    UPDATE users SET department_id = NULL
      WHERE department_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM departments WHERE id = users.department_id);
    ALTER TABLE users ADD CONSTRAINT users_department_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- users.branch_id -> branches(id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_branch_id_fk') THEN
    UPDATE users SET branch_id = NULL
      WHERE branch_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM branches WHERE id = users.branch_id);
    ALTER TABLE users ADD CONSTRAINT users_branch_id_fk
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 3. Missing org_id indexes for multi-tenant query performance
------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_roles_org                       ON roles(org_id);
CREATE INDEX IF NOT EXISTS idx_csat_responses_org              ON csat_responses(org_id);
CREATE INDEX IF NOT EXISTS idx_sprints_org                     ON sprints(org_id);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_org          ON ticket_attachments(org_id);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_org             ON ticket_comments(org_id);
CREATE INDEX IF NOT EXISTS idx_asset_returns_org               ON asset_returns(org_id);
CREATE INDEX IF NOT EXISTS idx_background_verifications_org    ON background_verifications(org_id);
CREATE INDEX IF NOT EXISTS idx_candidate_applications_org      ON candidate_applications(org_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_org         ON candidate_documents(org_id);
CREATE INDEX IF NOT EXISTS idx_candidate_referrals_org         ON candidate_referrals(org_id);
CREATE INDEX IF NOT EXISTS idx_certifications_org              ON certifications(org_id);
CREATE INDEX IF NOT EXISTS idx_document_audit_logs_org         ON document_audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_document_template_versions_org  ON document_template_versions(org_id);
CREATE INDEX IF NOT EXISTS idx_employee_devices_org            ON employee_devices(org_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_org            ON helpdesk_tickets(org_id);
CREATE INDEX IF NOT EXISTS idx_holidays_org                    ON holidays(org_id);
CREATE INDEX IF NOT EXISTS idx_interview_booking_links_org     ON interview_booking_links(org_id);
CREATE INDEX IF NOT EXISTS idx_interviews_org                  ON interviews(org_id);
CREATE INDEX IF NOT EXISTS idx_performance_improvement_plans_org ON performance_improvement_plans(org_id);
CREATE INDEX IF NOT EXISTS idx_policy_acknowledgments_org      ON policy_acknowledgments(org_id);
CREATE INDEX IF NOT EXISTS idx_training_enrollments_org        ON training_enrollments(org_id);
CREATE INDEX IF NOT EXISTS idx_wfh_requests_org                ON wfh_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_org              ON crm_activities(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_org                   ON crm_leads(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_support_team_members_org    ON crm_support_team_members(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_support_tickets_org         ON crm_support_tickets(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_people_org                  ON crm_people(org_id);

------------------------------------------------------------------------------
-- 4. Missing indexes on FK columns (performance: required for cascade deletes)
------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ab_tests_created_by             ON ab_tests(created_by);
CREATE INDEX IF NOT EXISTS idx_announcements_author            ON announcements(author_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by             ON api_keys(created_by);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_assessment  ON assessment_attempts(assessment_id);
CREATE INDEX IF NOT EXISTS idx_asset_returns_asset             ON asset_returns(asset_id);
CREATE INDEX IF NOT EXISTS idx_bonuses_approved_by             ON bonuses(approved_by);
CREATE INDEX IF NOT EXISTS idx_branches_manager                ON branches(branch_manager_id);
CREATE INDEX IF NOT EXISTS idx_branches_hr                     ON branches(branch_hr_id);
CREATE INDEX IF NOT EXISTS idx_calibration_sessions_job        ON calibration_sessions(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_calibration_sessions_created_by ON calibration_sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_template    ON candidate_documents(template_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_created_by  ON candidate_documents(created_by);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_vault_uploaded_by ON candidate_documents_vault(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_candidate_offers_job            ON candidate_offers(job_posting_id);
CREATE INDEX IF NOT EXISTS idx_candidate_offers_offered_by     ON candidate_offers(offered_by);
CREATE INDEX IF NOT EXISTS idx_candidate_reference_checks_created_by ON candidate_reference_checks(created_by);
CREATE INDEX IF NOT EXISTS idx_candidate_sources_created_by    ON candidate_sources(created_by);
CREATE INDEX IF NOT EXISTS idx_candidates_referred_by          ON candidates(referred_by);
CREATE INDEX IF NOT EXISTS idx_candidates_duplicate_of         ON candidates(duplicate_of_id);
CREATE INDEX IF NOT EXISTS idx_chat_channels_created_by        ON chat_channels(created_by);
CREATE INDEX IF NOT EXISTS idx_chat_channels_linked_deal       ON chat_channels(linked_deal_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to          ON chat_messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_client_accounts_assigned_crm    ON client_accounts(assigned_crm_id);
CREATE INDEX IF NOT EXISTS idx_client_accounts_branch          ON client_accounts(branch_id);
CREATE INDEX IF NOT EXISTS idx_client_accounts_lead            ON client_accounts(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_onboarding_items_assignee ON client_onboarding_items(assigned_to);
CREATE INDEX IF NOT EXISTS idx_client_onboarding_items_completed_by ON client_onboarding_items(completed_by);
CREATE INDEX IF NOT EXISTS idx_client_onboarding_items_template ON client_onboarding_items(template_id);
CREATE INDEX IF NOT EXISTS idx_client_onboarding_templates_created_by ON client_onboarding_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_client_opportunities_created_by ON client_opportunities(created_by);
CREATE INDEX IF NOT EXISTS idx_clients_lead                    ON clients(lead_id);
CREATE INDEX IF NOT EXISTS idx_projects_deal                   ON projects(deal_id);
CREATE INDEX IF NOT EXISTS idx_targets_branch_id               ON targets(branch_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_lead     ON calendar_events(linked_lead_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_deal     ON calendar_events(linked_deal_id);
CREATE INDEX IF NOT EXISTS idx_tickets_state                   ON tickets(state_id);
CREATE INDEX IF NOT EXISTS idx_tickets_module                  ON tickets(module_id);
CREATE INDEX IF NOT EXISTS idx_tickets_cycle                   ON tickets(cycle_id);
CREATE INDEX IF NOT EXISTS idx_users_department                ON users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_branch                    ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_reporting_to              ON users(reporting_to);
CREATE INDEX IF NOT EXISTS idx_tasks_parent                    ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_templates_department ON onboarding_templates(department_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_candidate   ON candidate_documents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_documents_vault_candidate ON candidate_documents_vault(candidate_id);
