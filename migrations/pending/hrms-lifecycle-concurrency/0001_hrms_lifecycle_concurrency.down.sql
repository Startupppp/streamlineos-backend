DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.resignations WHERE row_version <> 1)
    OR EXISTS (SELECT 1 FROM public.terminations WHERE row_version <> 1) THEN
    RAISE EXCEPTION 'HRMS_LIFECYCLE_ROLLBACK_REFUSED_ROW_VERSION_IN_USE';
  END IF;
END
$$;

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_onboarding_documents_org_user_type_version;

ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS chk_attendance_status;

ALTER TABLE public.onboarding_template_steps
  DROP CONSTRAINT IF EXISTS chk_onboarding_template_steps_owner_role;

ALTER TABLE public.onboarding_tasks
  DROP CONSTRAINT IF EXISTS chk_onboarding_tasks_owner_role,
  DROP CONSTRAINT IF EXISTS chk_onboarding_tasks_status;

ALTER TABLE public.onboarding_documents
  DROP CONSTRAINT IF EXISTS chk_onboarding_documents_version_positive;

ALTER TABLE public.leave_requests
  DROP CONSTRAINT IF EXISTS chk_leave_requests_priority,
  DROP CONSTRAINT IF EXISTS chk_leave_requests_half_day_period;

ALTER TABLE public.leave_blackout_dates
  DROP CONSTRAINT IF EXISTS chk_leave_blackout_dates_applies_to;

ALTER TABLE public.resignations
  DROP CONSTRAINT IF EXISTS chk_resignations_row_version,
  DROP COLUMN IF EXISTS row_version;

ALTER TABLE public.terminations
  DROP CONSTRAINT IF EXISTS chk_terminations_row_version,
  DROP COLUMN IF EXISTS row_version;
