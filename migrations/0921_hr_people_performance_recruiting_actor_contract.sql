-- @irreversible
-- 0921: Contract scoped HR authority references to organization_members.
--
-- The legacy users.id columns deliberately remain: they are immutable display
-- projections for historical exports and API compatibility.  Tenant authority is
-- the corresponding *_membership_id column.  This migration is intentionally a
-- cutover migration: it first backfills and proves every non-null legacy actor is
-- resolvable in its own organization, installs a fail-closed write fence, validates
-- membership FKs, and only then removes the users.id FKs.

SET lock_timeout = '5s';

CREATE TEMP TABLE _hr_actor_contract (
  table_name text NOT NULL,
  legacy_column text NOT NULL,
  membership_column text NOT NULL,
  PRIMARY KEY (table_name, legacy_column)
) ON COMMIT DROP;

INSERT INTO _hr_actor_contract (table_name, legacy_column, membership_column) VALUES
  ('hr_reporting_lines', 'created_by', 'created_by_membership_id'),
  ('review_cycles', 'created_by', 'created_by_membership_id'),
  ('performance_reviews', 'reviewer_id', 'reviewer_membership_id'),
  ('pulse_surveys', 'created_by', 'created_by_membership_id'),
  ('skill_assessments', 'created_by', 'created_by_membership_id'),
  ('feedback_cycles', 'created_by', 'created_by_membership_id'),
  ('hr_succession_plans', 'created_by', 'created_by_membership_id'),
  ('hr_mood_checkins', 'user_id', 'user_membership_id'),
  ('recognitions', 'from_user_id', 'from_membership_id'),
  ('recognitions', 'to_user_id', 'to_membership_id'),
  ('hr_badge_awards', 'awarded_by', 'awarded_by_membership_id'),
  ('hr_polls', 'created_by', 'created_by_membership_id'),
  ('hr_communities', 'created_by', 'created_by_membership_id'),
  ('hr_campaigns', 'created_by', 'created_by_membership_id'),
  ('candidate_referrals', 'referred_by', 'referred_by_membership_id'),
  ('candidate_documents_vault', 'uploaded_by', 'uploaded_by_membership_id'),
  ('vault_access_logs', 'accessed_by', 'accessed_by_membership_id'),
  ('candidate_reference_checks', 'created_by', 'created_by_membership_id'),
  ('candidate_messages', 'sent_by', 'sent_by_membership_id'),
  ('hiring_flows', 'created_by', 'created_by_membership_id'),
  ('scorecard_templates', 'created_by', 'created_by_membership_id'),
  ('job_postings', 'posted_by', 'posted_by_membership_id'),
  ('candidate_sources', 'created_by', 'created_by_membership_id'),
  ('pipeline_automations', 'created_by', 'created_by_membership_id'),
  ('offer_letter_templates', 'created_by', 'created_by_membership_id'),
  ('candidate_offers', 'offered_by', 'offered_by_membership_id'),
  ('candidate_offers', 'approved_by', 'approved_by_membership_id'),
  ('offer_versions', 'changed_by', 'changed_by_membership_id'),
  ('offer_negotiations', 'created_by', 'created_by_membership_id'),
  ('email_sequences', 'created_by', 'created_by_membership_id'),
  ('recruitment_vendors', 'created_by', 'created_by_membership_id'),
  ('headcount_requests', 'requested_by', 'requested_by_membership_id'),
  ('headcount_requests', 'approved_by', 'approved_by_membership_id'),
  ('job_recruiters', 'assigned_by', 'assigned_by_membership_id'),
  ('job_board_postings', 'posted_by', 'posted_by_membership_id'),
  ('job_board_postings', 'created_by', 'created_by_membership_id'),
  ('talent_pools', 'created_by', 'created_by_membership_id'),
  ('talent_pool_members', 'added_by', 'added_by_membership_id'),
  ('interviews', 'interviewer_id', 'interviewer_membership_id'),
  ('interview_scorecards', 'interviewer_id', 'interviewer_membership_id'),
  ('interview_booking_links', 'created_by', 'created_by_membership_id'),
  ('calibration_sessions', 'created_by', 'created_by_membership_id'),
  ('interview_questions', 'created_by', 'created_by_membership_id'),
  ('hr_workflow_instances', 'requested_by', 'requested_by_membership_id'),
  ('hr_workflow_instances', 'subject_employee_id', 'subject_employee_membership_id'),
  ('hr_workflow_step_actions', 'approver_user_id', 'approver_membership_id'),
  ('hr_workflow_step_actions', 'acted_by_user_id', 'acted_by_membership_id'),
  ('hr_workflow_delegations', 'delegator_user_id', 'delegator_membership_id'),
  ('hr_workflow_delegations', 'delegate_user_id', 'delegate_membership_id');

--> statement-breakpoint
DO $$
DECLARE spec record;
BEGIN
  FOR spec IN SELECT * FROM _hr_actor_contract ORDER BY table_name, legacy_column LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I integer', spec.table_name, spec.membership_column);
    EXECUTE format(
      'UPDATE %I row SET %I = member.id FROM organization_members member
       WHERE member.org_id = row.org_id
         AND member.user_id = row.%I
         AND row.%I IS NULL',
      spec.table_name, spec.membership_column, spec.legacy_column, spec.membership_column
    );
  END LOOP;
END $$;

--> statement-breakpoint
DO $$
DECLARE spec record;
DECLARE unmappable_count bigint;
BEGIN
  FOR spec IN SELECT * FROM _hr_actor_contract ORDER BY table_name, legacy_column LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS NULL',
      spec.table_name, spec.legacy_column, spec.membership_column
    ) INTO unmappable_count;
    IF unmappable_count > 0 THEN
      RAISE EXCEPTION '0921 blocked: %.% has % legacy actor row(s) without an organization membership',
        spec.table_name, spec.legacy_column, unmappable_count;
    END IF;
  END LOOP;
END $$;

--> statement-breakpoint
-- A write using a legacy display id is accepted only when it resolves to an
-- organization member. This lets old request payloads remain compatible while
-- making the membership column the sole authoritative representation.
CREATE OR REPLACE FUNCTION public.hr_sync_actor_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE legacy_user_id text;
DECLARE resolved_membership_id integer;
BEGIN
  legacy_user_id := to_jsonb(NEW) ->> TG_ARGV[0];
  IF legacy_user_id IS NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], NULL));
    RETURN NEW;
  END IF;

  SELECT id INTO resolved_membership_id
  FROM organization_members
  WHERE org_id = NEW.org_id AND user_id = legacy_user_id;

  IF resolved_membership_id IS NULL THEN
    RAISE EXCEPTION 'HR actor %.% does not belong to organization %', TG_TABLE_NAME, TG_ARGV[0], NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], resolved_membership_id));
  RETURN NEW;
END $$;

DO $$
DECLARE spec record;
DECLARE constraint_name text;
DECLARE trigger_name text;
BEGIN
  FOR spec IN SELECT * FROM _hr_actor_contract ORDER BY table_name, legacy_column LOOP
    constraint_name := format('fk_hr_actor_%s', substr(md5(spec.table_name || '.' || spec.legacy_column), 1, 16));
    trigger_name := format('tr_hr_actor_%s', substr(md5(spec.table_name || '.' || spec.legacy_column), 1, 16));
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', spec.table_name, constraint_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, %I)
       REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID',
      spec.table_name, constraint_name, spec.membership_column
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id, %I)',
      format('idx_hr_actor_%s', substr(md5(spec.table_name || '.' || spec.membership_column), 1, 16)),
      spec.table_name, spec.membership_column
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, spec.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I
       FOR EACH ROW EXECUTE FUNCTION public.hr_sync_actor_membership(%L, %L)',
      trigger_name, spec.legacy_column, spec.table_name, spec.legacy_column, spec.membership_column
    );
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec.table_name, constraint_name);
  END LOOP;
END $$;

--> statement-breakpoint
-- Contract only after the membership keys and write fence are live and proven.
DO $$
DECLARE spec record;
DECLARE legacy_fk record;
BEGIN
  FOR spec IN SELECT * FROM _hr_actor_contract ORDER BY table_name, legacy_column LOOP
    FOR legacy_fk IN
      SELECT kcu.constraint_name
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
