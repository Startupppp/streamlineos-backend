-- Phase 1: Missing org-scoped indexes on CRM sub-tables + clients type corrections.
--
-- Indexes A2-A5, A7: lead_* sub-tables and target_history were deliberately
-- skipped in 0112/0113 with the note "queries go through parent FK only".
-- That holds for single-lead detail views but breaks for org-level reports,
-- activity dashboards, and bulk operations that filter by org_id directly.
-- Index A11: email_campaign_recipients.lead_id for reverse-lookup queries.
--
-- B2: clients.health_status — cast text to the already-defined crm_health enum.
--     Stale values (anything outside healthy/at_risk/critical) are normalised to
--     'healthy' before the cast so the ALTER never fails.
-- C1: clients.converted_at — drop NOT NULL. A client row created via direct
--     entry has no meaningful conversion timestamp; the column should be nullable.

-- A2: lead_activities — org-level timeline / activity-report queries
CREATE INDEX IF NOT EXISTS idx_lead_activities_org_date
    ON lead_activities(org_id, date);

-- A3: lead_notes — org-level notes feed
CREATE INDEX IF NOT EXISTS idx_lead_notes_org_created
    ON lead_notes(org_id, created_at);

-- A4: lead_tasks — org-level task dashboard (filter by org + status)
CREATE INDEX IF NOT EXISTS idx_lead_tasks_org_status
    ON lead_tasks(org_id, status);

-- A5: lead_emails — org-level email log / analytics
CREATE INDEX IF NOT EXISTS idx_lead_emails_org_sent
    ON lead_emails(org_id, sent_at);

-- A7: target_history — org-level audit trail of target changes
CREATE INDEX IF NOT EXISTS idx_target_history_org_created
    ON target_history(org_id, created_at);

-- A11: email_campaign_recipients — reverse-lookup: which campaigns reached a lead
CREATE INDEX IF NOT EXISTS idx_ecr_lead
    ON email_campaign_recipients(lead_id);

-- B2: cast clients.health_status from text to crm_health enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_attribute  a
    JOIN   pg_type       t ON a.atttypid  = t.oid
    JOIN   pg_class      c ON a.attrelid  = c.oid
    WHERE  c.relname = 'clients'
      AND  a.attname = 'health_status'
      AND  t.typname = 'crm_health'
  ) THEN
    UPDATE clients
    SET    health_status = 'healthy'
    WHERE  health_status NOT IN ('healthy', 'at_risk', 'critical');

    ALTER TABLE clients
      ALTER COLUMN health_status TYPE crm_health
      USING health_status::crm_health;
  END IF;
END $$;

-- C1: drop NOT NULL on clients.converted_at
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_name  = 'clients'
      AND  column_name = 'converted_at'
      AND  is_nullable = 'NO'
  ) THEN
    ALTER TABLE clients ALTER COLUMN converted_at DROP NOT NULL;
  END IF;
END $$;
