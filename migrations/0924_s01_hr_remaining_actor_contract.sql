-- @irreversible
-- 0924: S01 HR remaining actor contraction.
--
-- A users.id is retained as an immutable historical display projection.  Every
-- tenant-scoped actor/subject below is additionally keyed by its membership in
-- that tenant.  Reads must use the membership column for authority and join
-- organization_members -> users only when rendering the historical display.

SET lock_timeout = '5s';

CREATE TEMP TABLE _s01_hr_actor_contract (
  table_name text NOT NULL,
  legacy_column text NOT NULL,
  membership_column text NOT NULL,
  PRIMARY KEY (table_name, legacy_column)
) ON COMMIT DROP;

INSERT INTO _s01_hr_actor_contract (table_name, legacy_column, membership_column) VALUES
  ('hr_case_notes', 'author_id', 'author_membership_id'),
  ('hr_case_documents', 'uploaded_by', 'uploaded_by_membership_id'),
  ('hr_disciplinary_actions', 'issued_by', 'issued_by_membership_id'),
  ('hr_disciplinary_actions', 'acknowledged_by', 'acknowledged_by_membership_id'),
  ('rich_documents', 'created_by', 'created_by_membership_id'),
  ('rich_documents', 'updated_by', 'updated_by_membership_id'),
  ('documents', 'uploaded_by', 'uploaded_by_membership_id'),
  ('handbook_versions', 'published_by', 'published_by_membership_id'),
  ('hr_email_templates', 'created_by', 'created_by_membership_id'),
  ('team_events', 'organized_by', 'organized_by_membership_id'),
  ('document_templates', 'created_by', 'created_by_membership_id'),
  ('candidate_documents', 'created_by', 'created_by_membership_id'),
  ('document_template_versions', 'archived_by', 'archived_by_membership_id'),
  ('onboarding_templates', 'created_by', 'created_by_membership_id'),
  ('onboarding_tasks', 'completed_by', 'completed_by_membership_id'),
  ('onboarding_documents', 'reviewed_by', 'reviewed_by_membership_id'),
  ('document_audit_logs', 'performed_by', 'performed_by_membership_id'),
  ('resignations', 'approved_by', 'approved_by_membership_id'),
  ('resignations', 'hr_reviewed_by', 'hr_reviewed_by_membership_id'),
  ('resignations', 'final_reviewed_by', 'final_reviewed_by_membership_id'),
  ('resignations', 'exit_interview_conducted_by', 'exit_interview_conducted_by_membership_id'),
  ('terminations', 'initiated_by', 'initiated_by_membership_id'),
  ('terminations', 'final_reviewed_by', 'final_reviewed_by_membership_id'),
  ('hr_insurance_claims', 'decided_by', 'decided_by_membership_id'),
  ('hr_payroll_variance_approvals', 'approver_id', 'approver_membership_id'),
  ('hr_arrears_adjustments', 'created_by', 'created_by_membership_id'),
  ('hr_payroll_compliance_tasks', 'completed_by', 'completed_by_membership_id'),
  ('hr_comp_cycles', 'created_by', 'created_by_membership_id'),
  ('hr_comp_recommendations', 'submitted_by', 'submitted_by_membership_id'),
  ('hr_comp_recommendations', 'calibrated_by', 'calibrated_by_membership_id'),
  ('hr_comp_recommendations', 'approved_by', 'approved_by_membership_id'),
  ('hr_equity_grants', 'created_by', 'created_by_membership_id'),
  ('hr_equity_exercises', 'created_by', 'created_by_membership_id'),
  ('hr_accommodation_requests', 'reviewed_by', 'reviewed_by_membership_id'),
  ('hr_emergency_events', 'created_by', 'created_by_membership_id'),
  ('hr_access_provisioning', 'verified_by', 'verified_by_membership_id'),
  ('hr_simulations', 'created_by', 'created_by_membership_id'),
  ('hr_event_stream', 'actor_user_id', 'actor_membership_id'),
  ('hr_legal_holds', 'placed_by', 'placed_by_membership_id'),
  ('hr_legal_holds', 'released_by', 'released_by_membership_id'),
  ('hr_data_requests', 'requested_by', 'requested_by_membership_id'),
  ('hr_data_requests', 'approved_by', 'approved_by_membership_id'),
  ('hr_proxy_access', 'created_by', 'created_by_membership_id'),
  ('hr_positions', 'incumbent_user_id', 'incumbent_membership_id'),
  ('hr_reorg_scenarios', 'created_by', 'created_by_membership_id'),
  ('hr_labor_cases', 'created_by', 'created_by_membership_id');

--> statement-breakpoint
DO $$
DECLARE spec record;
DECLARE unmappable_count bigint;
DECLARE constraint_name text;
DECLARE index_name text;
BEGIN
  FOR spec IN SELECT * FROM _s01_hr_actor_contract ORDER BY table_name, legacy_column LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I integer', spec.table_name, spec.membership_column);
    EXECUTE format(
      'UPDATE %I source SET %I = member.id FROM organization_members member
       WHERE member.org_id = source.org_id
         AND member.user_id = source.%I
         AND source.%I IS NULL',
      spec.table_name, spec.membership_column, spec.legacy_column, spec.membership_column
    );

    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS NULL',
      spec.table_name, spec.legacy_column, spec.membership_column
    ) INTO unmappable_count;
    IF unmappable_count > 0 THEN
      RAISE EXCEPTION '0923 blocked: %.% has % actor row(s) not mappable in its own organization',
        spec.table_name, spec.legacy_column, unmappable_count;
    END IF;

    constraint_name := format('fk_s01_hr_%s', substr(md5(spec.table_name || '.' || spec.membership_column), 1, 16));
    index_name := format('idx_s01_hr_%s', substr(md5(spec.table_name || '.' || spec.membership_column), 1, 16));
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', spec.table_name, constraint_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, %I)
       REFERENCES organization_members (org_id, id) ON DELETE SET NULL (%I) NOT VALID',
      spec.table_name, constraint_name, spec.membership_column, spec.membership_column
    );
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec.table_name, constraint_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id, %I)', index_name, spec.table_name, spec.membership_column);
  END LOOP;
END $$;

--> statement-breakpoint
-- Once the membership FK proves tenant ownership, legacy users.id constraints are
-- display-only and must not be mistaken for authorization constraints.
DO $$
DECLARE spec record;
DECLARE legacy_fk record;
BEGIN
  FOR spec IN SELECT * FROM _s01_hr_actor_contract ORDER BY table_name, legacy_column LOOP
    FOR legacy_fk IN
      SELECT tc.constraint_name
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      JOIN pg_constraint c ON c.conname = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = spec.table_name
        AND kcu.column_name = spec.legacy_column
        AND c.confrelid = 'users'::regclass
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', spec.table_name, legacy_fk.constraint_name);
    END LOOP;
  END LOOP;
END $$;
