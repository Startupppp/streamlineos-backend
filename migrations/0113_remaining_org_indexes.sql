-- Add org_id indexes on tables that lack them.
-- Tables NOT included (queries go through parent FK only):
--   lead_activities, lead_notes, lead_tasks, lead_emails (via lead_id)
--   target_history (via target_id)
--   project_statuses (via project_id)
--   employee_skills, salary_structures, bonuses, fnf_settlements (via user_id)
--   notification_preferences, push_subscriptions (via user_id)
--   qr_codes (via user_id or session)

CREATE INDEX IF NOT EXISTS idx_task_sequences_org           ON task_sequences(org_id);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_org        ON feedback_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_landing_pages_org_active     ON landing_pages(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_org_status     ON crm_campaigns(org_id, status);
CREATE INDEX IF NOT EXISTS idx_commission_rules_org_active  ON commission_rules(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_deal_approval_rules_org      ON deal_approval_rules(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_health     ON crm_companies(org_id, health);
CREATE INDEX IF NOT EXISTS idx_crm_deals_org_stage          ON crm_deals(org_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_content_org             ON crm_content(org_id);
CREATE INDEX IF NOT EXISTS idx_crm_monthly_metrics_org_month ON crm_monthly_metrics(org_id, month);
CREATE INDEX IF NOT EXISTS idx_crm_team_performance_org_month ON crm_team_performance(org_id, month);
CREATE INDEX IF NOT EXISTS idx_crm_events_org_status        ON crm_events(org_id, status);
CREATE INDEX IF NOT EXISTS idx_incentive_config_org_active  ON incentive_config(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_targets_org                  ON targets(org_id);
