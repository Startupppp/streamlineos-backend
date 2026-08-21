DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.attendance
    WHERE status NOT IN (
      'PRESENT', 'ON_BREAK', 'CHECKED_OUT', 'ABSENT', 'HALF_DAY', 'LATE',
      'WFH', 'HALFDAY', 'HOLIDAY_WORK', 'LEAVE_WITHOUT_PAY'
    )
  ) THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_STATUS_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.onboarding_template_steps
    WHERE owner_role NOT IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')
  ) OR EXISTS (
    SELECT 1
    FROM public.onboarding_tasks
    WHERE owner_role NOT IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')
  ) THEN
    RAISE EXCEPTION 'HRMS_ONBOARDING_OWNER_ROLE_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.onboarding_tasks
    WHERE status NOT IN ('PENDING', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'HRMS_ONBOARDING_TASK_STATUS_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.onboarding_documents
    WHERE version <= 0
  ) THEN
    RAISE EXCEPTION 'HRMS_ONBOARDING_DOCUMENT_VERSION_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leave_requests
    WHERE priority NOT IN ('LOW', 'MEDIUM', 'HIGH')
      OR (half_day_period IS NOT NULL AND half_day_period NOT IN ('AM', 'PM'))
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_REQUEST_TYPE_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leave_blackout_dates
    WHERE length(btrim(applies_to)) = 0
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_BLACKOUT_SCOPE_REQUIRES_REVIEW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.onboarding_documents
    GROUP BY org_id, user_id, document_type_id, version
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'HRMS_ONBOARDING_DOCUMENT_VERSION_DUPLICATE';
  END IF;

  IF EXISTS (SELECT 1 FROM public.resignations WHERE row_version IS NULL OR row_version <= 0)
    OR EXISTS (SELECT 1 FROM public.terminations WHERE row_version IS NULL OR row_version <= 0) THEN
    RAISE EXCEPTION 'HRMS_LIFECYCLE_ROW_VERSION_BACKFILL_REQUIRED';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_resignations_row_version_not_null') THEN
    ALTER TABLE public.resignations
      ADD CONSTRAINT chk_resignations_row_version_not_null
      CHECK (row_version IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_terminations_row_version_not_null') THEN
    ALTER TABLE public.terminations
      ADD CONSTRAINT chk_terminations_row_version_not_null
      CHECK (row_version IS NOT NULL) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.resignations VALIDATE CONSTRAINT chk_resignations_row_version_not_null;
ALTER TABLE public.terminations VALIDATE CONSTRAINT chk_terminations_row_version_not_null;

ALTER TABLE public.resignations
  ALTER COLUMN row_version SET NOT NULL;

ALTER TABLE public.terminations
  ALTER COLUMN row_version SET NOT NULL;

ALTER TABLE public.resignations
  DROP CONSTRAINT chk_resignations_row_version_not_null;

ALTER TABLE public.terminations
  DROP CONSTRAINT chk_terminations_row_version_not_null;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_attendance_status') THEN
    ALTER TABLE public.attendance
      ADD CONSTRAINT chk_attendance_status
      CHECK (status IN (
        'PRESENT', 'ON_BREAK', 'CHECKED_OUT', 'ABSENT', 'HALF_DAY', 'LATE',
        'WFH', 'HALFDAY', 'HOLIDAY_WORK', 'LEAVE_WITHOUT_PAY'
      )) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onboarding_template_steps_owner_role') THEN
    ALTER TABLE public.onboarding_template_steps
      ADD CONSTRAINT chk_onboarding_template_steps_owner_role
      CHECK (owner_role IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onboarding_tasks_owner_role') THEN
    ALTER TABLE public.onboarding_tasks
      ADD CONSTRAINT chk_onboarding_tasks_owner_role
      CHECK (owner_role IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onboarding_tasks_status') THEN
    ALTER TABLE public.onboarding_tasks
      ADD CONSTRAINT chk_onboarding_tasks_status
      CHECK (status IN ('PENDING', 'COMPLETED')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onboarding_documents_version_positive') THEN
    ALTER TABLE public.onboarding_documents
      ADD CONSTRAINT chk_onboarding_documents_version_positive
      CHECK (version > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_leave_requests_priority') THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT chk_leave_requests_priority
      CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_leave_requests_half_day_period') THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT chk_leave_requests_half_day_period
      CHECK (half_day_period IS NULL OR half_day_period IN ('AM', 'PM')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_leave_blackout_dates_applies_to') THEN
    ALTER TABLE public.leave_blackout_dates
      ADD CONSTRAINT chk_leave_blackout_dates_applies_to
      CHECK (length(btrim(applies_to)) > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_resignations_row_version') THEN
    ALTER TABLE public.resignations
      ADD CONSTRAINT chk_resignations_row_version
      CHECK (row_version > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_terminations_row_version') THEN
    ALTER TABLE public.terminations
      ADD CONSTRAINT chk_terminations_row_version
      CHECK (row_version > 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.attendance VALIDATE CONSTRAINT chk_attendance_status;
ALTER TABLE public.onboarding_template_steps VALIDATE CONSTRAINT chk_onboarding_template_steps_owner_role;
ALTER TABLE public.onboarding_tasks VALIDATE CONSTRAINT chk_onboarding_tasks_owner_role;
ALTER TABLE public.onboarding_tasks VALIDATE CONSTRAINT chk_onboarding_tasks_status;
ALTER TABLE public.onboarding_documents VALIDATE CONSTRAINT chk_onboarding_documents_version_positive;
ALTER TABLE public.leave_requests VALIDATE CONSTRAINT chk_leave_requests_priority;
ALTER TABLE public.leave_requests VALIDATE CONSTRAINT chk_leave_requests_half_day_period;
ALTER TABLE public.leave_blackout_dates VALIDATE CONSTRAINT chk_leave_blackout_dates_applies_to;
ALTER TABLE public.resignations VALIDATE CONSTRAINT chk_resignations_row_version;
ALTER TABLE public.terminations VALIDATE CONSTRAINT chk_terminations_row_version;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_onboarding_documents_org_user_type_version
  ON public.onboarding_documents (org_id, user_id, document_type_id, version);
