-- @irreversible
-- 0926: Remove legacy users.id authority foreign keys after S03 membership cutover.
-- Legacy user columns remain immutable display projections; membership columns carry
-- tenant-scoped authority and are validated by the preceding expansion migrations.

SET lock_timeout = '5s';

DO $$
DECLARE
  target record;
  constraint_name text;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('affiliates', 'user_id'),
      ('ai_chat_conversations', 'user_id'),
      ('ai_chat_messages', 'user_id'),
      ('ai_action_proposals', 'user_id'),
      ('fin_approval_policies', 'approver_user_id'),
      ('journal_entries', 'created_by'),
      ('expenses', 'user_id'),
      ('reimbursements', 'user_id'),
      ('salary_loans', 'user_id'),
      ('bonuses', 'user_id'),
      ('fnf_settlements', 'user_id'),
      ('asset_returns', 'user_id'),
      ('hr_payroll_input_snapshots', 'user_id'),
      ('hr_payroll_adjustments', 'user_id'),
      ('payroll_inputs', 'user_id'),
      ('payslip_publications', 'user_id'),
      ('payroll_run_employees', 'user_id'),
      ('employee_salary_profiles', 'user_id')
    ) AS requested(table_name, column_name)
  LOOP
    FOR constraint_name IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY child_key(attnum, ord) ON true
      JOIN pg_attribute child_attribute
        ON child_attribute.attrelid = child.oid
       AND child_attribute.attnum = child_key.attnum
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY parent_key(attnum, ord)
        ON parent_key.ord = child_key.ord
      JOIN pg_attribute parent_attribute
        ON parent_attribute.attrelid = parent.oid
       AND parent_attribute.attnum = parent_key.attnum
      WHERE c.contype = 'f'
        AND child_schema.nspname = 'public'
        AND child.relname = target.table_name
        AND child_attribute.attname = target.column_name
        AND parent_schema.nspname = 'public'
        AND parent.relname = 'users'
        AND parent_attribute.attname = 'id'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, constraint_name);
    END LOOP;
  END LOOP;
END $$;

DO $$
DECLARE unresolved bigint;
BEGIN
  SELECT count(*) INTO unresolved
  FROM (
    SELECT user_id FROM public.ai_chat_conversations WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.ai_chat_messages WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.ai_action_proposals WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.expenses WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.reimbursements WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.salary_loans WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.bonuses WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.fnf_settlements WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.asset_returns WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.hr_payroll_input_snapshots WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.hr_payroll_adjustments WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.payroll_inputs WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.payslip_publications WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.payroll_run_employees WHERE user_id IS NOT NULL AND user_membership_id IS NULL
    UNION ALL SELECT user_id FROM public.employee_salary_profiles WHERE user_id IS NOT NULL AND user_membership_id IS NULL
  ) unresolved_rows;
  IF unresolved > 0 THEN
    RAISE EXCEPTION '0926 blocked: % S03 payroll/AI authority rows have no membership mapping', unresolved;
  END IF;
END $$;
