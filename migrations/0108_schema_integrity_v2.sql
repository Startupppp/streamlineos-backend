-- Schema integrity audit pass v2.
-- Generated manually because drizzle/meta snapshots are out of sync with the live schema.
-- Apply this BEFORE the next `drizzle-kit generate` run; the snapshot will catch up on the next migration.
--
-- IMPORTANT: This migration touches many tables. Review each block and run on a clone before prod.
-- Each section is independently safe (uses IF EXISTS / IF NOT EXISTS / DO blocks).

------------------------------------------------------------------------------
-- 1. CRITICAL: Composite primary keys on accounts + verification_tokens
--    Drizzle's old `compoundKey: { primaryKey: [...] }` syntax was silently
--    ignored, so these NextAuth tables had no primary key in production.
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_provider_provider_account_id_pk'
  ) THEN
    -- Defensive: drop dup rows that would block the PK
    DELETE FROM accounts a USING accounts b
      WHERE a.ctid < b.ctid
        AND a.provider = b.provider
        AND a.provider_account_id = b.provider_account_id;
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_provider_provider_account_id_pk
      PRIMARY KEY (provider, provider_account_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'verification_tokens_identifier_token_pk'
  ) THEN
    DELETE FROM verification_tokens a USING verification_tokens b
      WHERE a.ctid < b.ctid
        AND a.identifier = b.identifier
        AND a.token = b.token;
    ALTER TABLE verification_tokens
      ADD CONSTRAINT verification_tokens_identifier_token_pk
      PRIMARY KEY (identifier, token);
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. Drop redundant duplicate FK columns on deals
--    (deals.linkedLeadId/linkedClientId duplicate deals.leadId/clientId)
------------------------------------------------------------------------------
ALTER TABLE deals DROP COLUMN IF EXISTS linked_lead_id;
ALTER TABLE deals DROP COLUMN IF EXISTS linked_client_id;

------------------------------------------------------------------------------
-- 3. Convert tickets.type from text to ticket_type enum
--    Existing values should map cleanly: EPIC/STORY/TASK/BUG.
--    Anything else (e.g. SUBTASK from old code) becomes TASK.
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_type') THEN
    CREATE TYPE ticket_type AS ENUM ('EPIC', 'STORY', 'TASK', 'BUG');
  END IF;
END $$;

UPDATE tickets SET type = 'STORY' WHERE type = 'FEATURE';
UPDATE tickets SET type = 'TASK'
  WHERE type IS NULL OR type NOT IN ('EPIC', 'STORY', 'TASK', 'BUG');

-- Drop default first because Postgres can't auto-cast a text default to enum
ALTER TABLE tickets ALTER COLUMN type DROP DEFAULT;
ALTER TABLE tickets ALTER COLUMN type TYPE ticket_type USING type::ticket_type;
ALTER TABLE tickets ALTER COLUMN type SET DEFAULT 'TASK'::ticket_type;
ALTER TABLE tickets ALTER COLUMN type SET NOT NULL;

ALTER TABLE tickets ALTER COLUMN status SET NOT NULL;
ALTER TABLE tickets ALTER COLUMN priority SET NOT NULL;

------------------------------------------------------------------------------
-- 4. Self-referential foreign keys that were declared in TS but missing in DB
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_merged_into_id_fk') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_merged_into_id_fk
      FOREIGN KEY (merged_into_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_parent_goal_id_fk') THEN
    ALTER TABLE goals ADD CONSTRAINT goals_parent_goal_id_fk
      FOREIGN KEY (parent_goal_id) REFERENCES goals(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parent_document_id_fk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parent_document_id_fk
      FOREIGN KEY (parent_document_id) REFERENCES documents(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_parent_comment_id_fk') THEN
    ALTER TABLE ticket_comments ADD CONSTRAINT ticket_comments_parent_comment_id_fk
      FOREIGN KEY (parent_comment_id) REFERENCES ticket_comments(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_reply_to_id_fk') THEN
    ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_reply_to_id_fk
      FOREIGN KEY (reply_to_id) REFERENCES chat_messages(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_accounts_parent_account_id_fk') THEN
    ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_parent_account_id_fk
      FOREIGN KEY (parent_account_id) REFERENCES ledger_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'targets_parent_target_id_fk') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_parent_target_id_fk
      FOREIGN KEY (parent_target_id) REFERENCES targets(id) ON DELETE SET NULL;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 5. Cross-ref FKs that were missing on integer "*Id" columns
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_organization_id_fk') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_organization_id_fk
      FOREIGN KEY (organization_id) REFERENCES crm_organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_template_versions_org_id_fk') THEN
    ALTER TABLE document_template_versions ADD CONSTRAINT document_template_versions_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landing_pages_org_id_fk') THEN
    ALTER TABLE landing_pages ADD CONSTRAINT landing_pages_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_views_org_id_fk') THEN
    ALTER TABLE page_views ADD CONSTRAINT page_views_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ab_tests_org_id_fk') THEN
    ALTER TABLE ab_tests ADD CONSTRAINT ab_tests_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_metrics_org_id_fk') THEN
    ALTER TABLE social_metrics ADD CONSTRAINT social_metrics_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_calendar_items_org_id_fk') THEN
    ALTER TABLE content_calendar_items ADD CONSTRAINT content_calendar_items_org_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_manager_id_fk') THEN
    ALTER TABLE departments ADD CONSTRAINT departments_manager_id_fk
      FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 6. Standardize decimal precision on money columns to (15, 2)
--    Postgres NUMERIC with no precision is unbounded; this enforces
--    consistent rounding without truncating existing values.
------------------------------------------------------------------------------
ALTER TABLE users           ALTER COLUMN monthly_salary     TYPE numeric(15, 2);
ALTER TABLE users           ALTER COLUMN experience_years   TYPE numeric(5, 2);
ALTER TABLE payrolls        ALTER COLUMN basic_salary       TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN hra                TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN allowances         TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN deductions         TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN gross_salary       TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN net_salary         TYPE numeric(15, 2);
ALTER TABLE payrolls        ALTER COLUMN overtime_days      TYPE numeric(6, 2);
ALTER TABLE payrolls        ALTER COLUMN overtime_hours     TYPE numeric(6, 2);
ALTER TABLE payrolls        ALTER COLUMN overtime_amount    TYPE numeric(15, 2);
ALTER TABLE salary_structures ALTER COLUMN basic_salary     TYPE numeric(15, 2);
ALTER TABLE salary_structures ALTER COLUMN hra_percentage   TYPE numeric(5, 2);
ALTER TABLE salary_structures ALTER COLUMN allowances       TYPE numeric(15, 2);
ALTER TABLE salary_structures ALTER COLUMN deductions       TYPE numeric(15, 2);
ALTER TABLE expenses        ALTER COLUMN amount             TYPE numeric(15, 2);
ALTER TABLE expense_categories ALTER COLUMN budget_limit    TYPE numeric(15, 2);
ALTER TABLE assets          ALTER COLUMN purchase_cost      TYPE numeric(15, 2);
ALTER TABLE reimbursements  ALTER COLUMN amount             TYPE numeric(15, 2);
ALTER TABLE salary_loans    ALTER COLUMN amount             TYPE numeric(15, 2);
ALTER TABLE salary_loans    ALTER COLUMN emi_amount         TYPE numeric(15, 2);
ALTER TABLE bonuses         ALTER COLUMN amount             TYPE numeric(15, 2);
ALTER TABLE terminations    ALTER COLUMN severance_amount   TYPE numeric(15, 2);
ALTER TABLE job_postings    ALTER COLUMN salary_min         TYPE numeric(15, 2);
ALTER TABLE job_postings    ALTER COLUMN salary_max         TYPE numeric(15, 2);
ALTER TABLE candidates      ALTER COLUMN experience_years   TYPE numeric(5, 2);
ALTER TABLE candidate_offers ALTER COLUMN offered_salary    TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN basic_dues         TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN leave_encashment   TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN bonus_due          TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN deductions         TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN loan_recovery      TYPE numeric(15, 2);
ALTER TABLE fnf_settlements ALTER COLUMN net_payable        TYPE numeric(15, 2);
ALTER TABLE goals           ALTER COLUMN target_value       TYPE numeric(15, 2);
ALTER TABLE goals           ALTER COLUMN current_value      TYPE numeric(15, 2);
ALTER TABLE key_results     ALTER COLUMN target_value       TYPE numeric(15, 2);
ALTER TABLE key_results     ALTER COLUMN current_value      TYPE numeric(15, 2);
ALTER TABLE attendance      ALTER COLUMN work_hours         TYPE numeric(6, 2);
ALTER TABLE attendance      ALTER COLUMN break_hours        TYPE numeric(6, 2);
ALTER TABLE leave_balances  ALTER COLUMN balance            TYPE numeric(6, 2);
ALTER TABLE performance_reviews ALTER COLUMN overall_rating TYPE numeric(4, 2);

ALTER TABLE projects        ALTER COLUMN budget             TYPE numeric(15, 2);
ALTER TABLE timesheets      ALTER COLUMN hours              TYPE numeric(6, 2);
ALTER TABLE tickets         ALTER COLUMN time_spent         TYPE numeric(10, 2);
ALTER TABLE tickets         ALTER COLUMN original_estimate  TYPE numeric(10, 2);
ALTER TABLE project_members ALTER COLUMN hourly_rate        TYPE numeric(10, 2);
ALTER TABLE project_template_tickets ALTER COLUMN estimated_hours TYPE numeric(8, 2);

ALTER TABLE leads           ALTER COLUMN investment_interest TYPE numeric(15, 2);
ALTER TABLE leads           ALTER COLUMN potential_value    TYPE numeric(15, 2);
ALTER TABLE clients         ALTER COLUMN investment_value   TYPE numeric(15, 2);
ALTER TABLE deals           ALTER COLUMN value              TYPE numeric(15, 2);
ALTER TABLE crm_campaigns   ALTER COLUMN spend              TYPE numeric(15, 2);
ALTER TABLE crm_campaigns   ALTER COLUMN roi                TYPE numeric(8, 4);
ALTER TABLE targets         ALTER COLUMN target_value       TYPE numeric(15, 2);
ALTER TABLE targets         ALTER COLUMN current_value      TYPE numeric(15, 2);
ALTER TABLE sales_quotas    ALTER COLUMN target_revenue     TYPE numeric(15, 2);
ALTER TABLE sales_quotas    ALTER COLUMN actual_revenue     TYPE numeric(15, 2);
ALTER TABLE commission_rules ALTER COLUMN flat_rate         TYPE numeric(5, 2);
ALTER TABLE commissions     ALTER COLUMN deal_value         TYPE numeric(15, 2);
ALTER TABLE commissions     ALTER COLUMN commission_rate    TYPE numeric(5, 2);
ALTER TABLE commissions     ALTER COLUMN commission_amount  TYPE numeric(15, 2);
ALTER TABLE deal_approval_rules ALTER COLUMN min_value      TYPE numeric(15, 2);
ALTER TABLE subscription_payments ALTER COLUMN amount       TYPE numeric(15, 2);

-- CRM shadow tables (used by dashboards)
ALTER TABLE crm_companies   ALTER COLUMN revenue            TYPE numeric(15, 2);
ALTER TABLE crm_companies   ALTER COLUMN renewal_value      TYPE numeric(15, 2);
ALTER TABLE crm_deals       ALTER COLUMN value              TYPE numeric(15, 2);
ALTER TABLE crm_content     ALTER COLUMN conv_rate          TYPE numeric(5, 2);
ALTER TABLE crm_monthly_metrics ALTER COLUMN revenue        TYPE numeric(15, 2);
ALTER TABLE crm_monthly_metrics ALTER COLUMN retention      TYPE numeric(5, 2);
ALTER TABLE crm_monthly_metrics ALTER COLUMN csat           TYPE numeric(4, 2);
ALTER TABLE crm_team_performance ALTER COLUMN value         TYPE numeric(15, 2);

-- Invoice money columns standardized to (18, 4) to match cgst/sgst/igst
ALTER TABLE invoices        ALTER COLUMN subtotal           TYPE numeric(18, 4);
ALTER TABLE invoices        ALTER COLUMN tax_rate           TYPE numeric(5, 2);
ALTER TABLE invoices        ALTER COLUMN tax_amount         TYPE numeric(18, 4);
ALTER TABLE invoices        ALTER COLUMN discount           TYPE numeric(18, 4);
ALTER TABLE invoices        ALTER COLUMN total              TYPE numeric(18, 4);

------------------------------------------------------------------------------
-- 7. Hot-path composite indexes for multi-tenant queries
------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_org_status_created  ON leads(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_deleted             ON leads(deleted_at);
CREATE INDEX IF NOT EXISTS idx_deals_org_stage_assignee  ON deals(org_id, stage, assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_deals_client              ON deals(client_id);
CREATE INDEX IF NOT EXISTS idx_deals_lead                ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_close_date          ON deals(expected_close_date);
CREATE INDEX IF NOT EXISTS idx_tickets_org_status_priority ON tickets(org_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_tickets_project_status    ON tickets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_payrolls_org_month_status ON payrolls(org_id, month, status);
CREATE INDEX IF NOT EXISTS idx_attendance_org_date_status ON attendance(org_id, date, status);
CREATE INDEX IF NOT EXISTS idx_expenses_org_status_date  ON expenses(org_id, status, expense_date);
CREATE INDEX IF NOT EXISTS idx_je_org_status             ON journal_entries(org_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_org_created ON notifications(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread      ON chat_messages(channel_id, is_deleted, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_org_type        ON documents(org_id, type);
CREATE INDEX IF NOT EXISTS idx_documents_user            ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_expiry          ON documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_goals_user_status         ON goals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_org_status          ON goals(org_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_org_status        ON clients(org_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_account_manager   ON clients(account_manager_id);
CREATE INDEX IF NOT EXISTS idx_assets_org_status         ON assets(org_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_assigned           ON assets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_salary_structures_user_active ON salary_structures(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_projects_org_status       ON projects(org_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_manager          ON projects(manager_id);
CREATE INDEX IF NOT EXISTS idx_sprints_project_status    ON sprints(project_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates      ON leave_requests(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_category  ON calendar_events(category);
CREATE INDEX IF NOT EXISTS idx_calendar_events_created_by ON calendar_events(created_by);
CREATE INDEX IF NOT EXISTS idx_ab_tests_org_status       ON ab_tests(org_id, status);
CREATE INDEX IF NOT EXISTS idx_content_calendar_org_status ON content_calendar_items(org_id, status);
CREATE INDEX IF NOT EXISTS idx_role_permissions_org      ON role_permissions(org_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_org      ON user_permissions(org_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_user     ON onboarding_steps(user_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_org_status ON onboarding_steps(org_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_org_email     ON invitations(org_id, email);
CREATE INDEX IF NOT EXISTS idx_invitations_expires       ON invitations(expires_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_email      ON password_reset_tokens(email);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires    ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_org_type          ON reports(org_id, type);
CREATE INDEX IF NOT EXISTS idx_project_templates_org     ON project_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_project_template_tickets_template ON project_template_tickets(template_id);
CREATE INDEX IF NOT EXISTS idx_project_statuses_project  ON project_statuses(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user      ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket    ON ticket_comments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_org_status     ON timesheets(org_id, status);

------------------------------------------------------------------------------
-- 8. Unique constraints that prevent duplicate business data
------------------------------------------------------------------------------
DO $$ BEGIN
  -- Skip if duplicates would block creation
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_payrolls_user_month') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_payrolls_user_month ON payrolls(user_id, month);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_payrolls_user_month — duplicate (user_id, month) rows exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_attendance_user_date') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_attendance_user_date ON attendance(user_id, date);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_attendance_user_date — duplicate (user_id, date) rows exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_leave_balances_user_type_year') THEN
    -- Dedupe first: keep row with highest balance per (user_id, leave_type_id, year)
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY user_id, leave_type_id, year
               ORDER BY balance::numeric DESC, id DESC
             ) AS rn
      FROM leave_balances
      WHERE leave_type_id IS NOT NULL
    )
    DELETE FROM leave_balances WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    BEGIN
      CREATE UNIQUE INDEX uniq_leave_balances_user_type_year
        ON leave_balances(user_id, leave_type_id, year)
        WHERE leave_type_id IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_leave_balances_user_type_year — duplicates still exist after dedup';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_leave_types_org_name') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_leave_types_org_name ON leave_types(org_id, name);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_leave_types_org_name — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_expense_categories_org_name') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_expense_categories_org_name ON expense_categories(org_id, name);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_expense_categories_org_name — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_departments_org_name') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_departments_org_name ON departments(org_id, name);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_departments_org_name — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_ticket_labels_org_name') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_ticket_labels_org_name ON ticket_labels(org_id, name);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_ticket_labels_org_name — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_ticket_label_mappings_ticket_label') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_ticket_label_mappings_ticket_label
        ON ticket_label_mappings(ticket_id, label_id);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_ticket_label_mappings — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_tickets_project_number') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_tickets_project_number
        ON tickets(project_id, ticket_number)
        WHERE project_id IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_tickets_project_number — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_user_permissions_user_perm_org') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_user_permissions_user_perm_org
        ON user_permissions(user_id, permission_id, org_id);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_user_permissions — duplicates exist';
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_role_permissions_role_perm_org') THEN
    BEGIN
      CREATE UNIQUE INDEX uniq_role_permissions_role_perm_org
        ON role_permissions(role, permission_id, org_id);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped uniq_role_permissions — duplicates exist';
    END;
  END IF;
END $$;
