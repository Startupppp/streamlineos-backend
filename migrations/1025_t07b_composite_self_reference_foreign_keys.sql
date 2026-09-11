-- Six declared self- and sibling-references with no constraint in the catalog at all.
--
-- Each of these columns is declared `.references(() => <table>.id, { onDelete: "set null" })`
-- in `src/db/schema/**` and carries no foreign key on a database cold-built to head:
--
--   support_tickets.merged_into_ticket_id      -> support_tickets
--   payroll_policies.active_version_id         -> payroll_policy_versions
--   payroll_runs.source_run_id                 -> payroll_runs
--   hr_policies.parent_policy_id               -> hr_policies
--   hr_templates.parent_template_id            -> hr_templates
--   hr_automation_runs.triggered_by_run_id     -> hr_automation_runs
--
-- Child and parent are tenant-owned on all six, so backend/CLAUDE.md section 3 makes the
-- correct shape COMPOSITE `(org_id, <col>) -> (org_id, id)`, not the single-column form the
-- declaration asks for: a single-column pointer lets a row in org A name a parent in org B,
-- which is exactly the hole these tables have today. Every parent already carries the
-- `uniq_<table>_org_id UNIQUE (org_id, id)` anchor the composite needs -- read from
-- pg_constraint per table before this file was written, not assumed.
--
-- Each SET NULL carries an EXPLICIT COLUMN LIST naming only the nullable pointer column.
-- `org_id` is NOT NULL on all six, so a bare composite SET NULL would try to null the
-- tenant column and raise 23502 on every parent delete -- the defect 0770 swept and 0992
-- repaired. All six pointer columns were confirmed nullable in pg_attribute.
--
-- No append-only or BEFORE UPDATE guard exists on any of the six (checked in pg_trigger:
-- the only trigger on any of them is trg_support_tickets_party, which fires on
-- `UPDATE OF client_id` and so is not reached by a SET NULL on merged_into_ticket_id).
-- That is the migration 1009 trap, checked rather than assumed.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE support_tickets
  ADD CONSTRAINT fk_support_tickets_merged_into_ticket
  FOREIGN KEY (org_id, merged_into_ticket_id) REFERENCES support_tickets (org_id, id)
  ON DELETE SET NULL (merged_into_ticket_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_policies
  ADD CONSTRAINT fk_payroll_policies_active_version
  FOREIGN KEY (org_id, active_version_id) REFERENCES payroll_policy_versions (org_id, id)
  ON DELETE SET NULL (active_version_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_runs
  ADD CONSTRAINT fk_payroll_runs_source_run
  FOREIGN KEY (org_id, source_run_id) REFERENCES payroll_runs (org_id, id)
  ON DELETE SET NULL (source_run_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_policies
  ADD CONSTRAINT fk_hr_policies_parent_policy
  FOREIGN KEY (org_id, parent_policy_id) REFERENCES hr_policies (org_id, id)
  ON DELETE SET NULL (parent_policy_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_templates
  ADD CONSTRAINT fk_hr_templates_parent_template
  FOREIGN KEY (org_id, parent_template_id) REFERENCES hr_templates (org_id, id)
  ON DELETE SET NULL (parent_template_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE hr_automation_runs
  ADD CONSTRAINT fk_hr_automation_runs_triggered_by_run
  FOREIGN KEY (org_id, triggered_by_run_id) REFERENCES hr_automation_runs (org_id, id)
  ON DELETE SET NULL (triggered_by_run_id) NOT VALID;
--> statement-breakpoint

ALTER TABLE support_tickets VALIDATE CONSTRAINT fk_support_tickets_merged_into_ticket;
--> statement-breakpoint

ALTER TABLE payroll_policies VALIDATE CONSTRAINT fk_payroll_policies_active_version;
--> statement-breakpoint

ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_source_run;
--> statement-breakpoint

ALTER TABLE hr_policies VALIDATE CONSTRAINT fk_hr_policies_parent_policy;
--> statement-breakpoint

ALTER TABLE hr_templates VALIDATE CONSTRAINT fk_hr_templates_parent_template;
--> statement-breakpoint

ALTER TABLE hr_automation_runs VALIDATE CONSTRAINT fk_hr_automation_runs_triggered_by_run;
--> statement-breakpoint

-- A SET NULL parent delete looks the child up by the foreign-key columns; without an index
-- leading with org_id that is a sequential scan per deleted parent row.
-- Not CONCURRENTLY: db:migrate runs inside a transaction.
CREATE INDEX IF NOT EXISTS idx_support_tickets_merged_into
  ON support_tickets (org_id, merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_policies_active_version
  ON payroll_policies (org_id, active_version_id) WHERE active_version_id IS NOT NULL;
--> statement-breakpoint

-- Not `idx_payroll_runs_source_run`: that name is already taken by a declared
-- `(source_run_id)` index, so `IF NOT EXISTS` would silently create nothing and leave the
-- new composite foreign key unindexed. Caught by reading pg_index after a first run, not
-- by trusting the migration's success. The existing narrow index is left in place.
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_source_run
  ON payroll_runs (org_id, source_run_id) WHERE source_run_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_policies_parent_policy
  ON hr_policies (org_id, parent_policy_id) WHERE parent_policy_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_templates_parent_template
  ON hr_templates (org_id, parent_template_id) WHERE parent_template_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_automation_runs_triggered_by_run
  ON hr_automation_runs (org_id, triggered_by_run_id) WHERE triggered_by_run_id IS NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(want.name || ' (' || want.why || ')', ', ') INTO broken
  FROM (
    SELECT name, col, CASE
      WHEN NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = name AND c.contype = 'f')
        THEN 'missing'
      WHEN NOT (SELECT c.convalidated FROM pg_constraint c WHERE c.conname = name)
        THEN 'not validated'
      WHEN (SELECT c.confdeltype FROM pg_constraint c WHERE c.conname = name) <> 'n'
        THEN 'not ON DELETE SET NULL'
      WHEN (SELECT c.confdelsetcols FROM pg_constraint c WHERE c.conname = name) IS NULL
        THEN 'SET NULL with no column list — would raise 23502 on org_id'
      WHEN EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN unnest(c.confdelsetcols) AS s(attnum) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = s.attnum
        WHERE c.conname = name AND a.attnotnull)
        THEN 'SET NULL column list names a NOT NULL column'
      ELSE NULL END AS why
    FROM (VALUES
      ('fk_support_tickets_merged_into_ticket', 'merged_into_ticket_id'),
      ('fk_payroll_policies_active_version', 'active_version_id'),
      ('fk_payroll_runs_source_run', 'source_run_id'),
      ('fk_hr_policies_parent_policy', 'parent_policy_id'),
      ('fk_hr_templates_parent_template', 'parent_template_id'),
      ('fk_hr_automation_runs_triggered_by_run', 'triggered_by_run_id')
    ) AS v(name, col)
  ) AS want
  WHERE want.why IS NOT NULL;

  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '1025 did not land cleanly: %', broken;
  END IF;

  -- `CREATE INDEX IF NOT EXISTS` is a no-op against a name already in use, whatever that
  -- index actually covers, so the name alone proves nothing. Assert the shape.
  SELECT string_agg(want.name, ', ') INTO broken
  FROM (VALUES
    ('idx_support_tickets_merged_into', 'org_id, merged_into_ticket_id'),
    ('idx_payroll_policies_active_version', 'org_id, active_version_id'),
    ('idx_payroll_runs_org_source_run', 'org_id, source_run_id'),
    ('idx_hr_policies_parent_policy', 'org_id, parent_policy_id'),
    ('idx_hr_templates_parent_template', 'org_id, parent_template_id'),
    ('idx_hr_automation_runs_triggered_by_run', 'org_id, triggered_by_run_id')
  ) AS want(name, cols)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    WHERE i.relname = want.name
      AND (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
             FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) = want.cols);
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION
      '1025: index name(s) present but not covering the foreign key columns (a silent IF NOT EXISTS collision): %', broken;
  END IF;
END
$$;
