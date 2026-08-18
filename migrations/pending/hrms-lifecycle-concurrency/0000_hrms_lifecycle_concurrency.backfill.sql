DO $$
BEGIN
  IF to_regclass('public.resignations') IS NULL
    OR to_regclass('public.terminations') IS NULL
    OR to_regclass('public.onboarding_documents') IS NULL
    OR to_regclass('public.onboarding_tasks') IS NULL
    OR to_regclass('public.onboarding_template_steps') IS NULL
    OR to_regclass('public.leave_requests') IS NULL
    OR to_regclass('public.leave_blackout_dates') IS NULL
    OR to_regclass('public.attendance') IS NULL THEN
    RAISE EXCEPTION 'HRMS_LIFECYCLE_CONCURRENCY_REQUIRED_TABLE_MISSING';
  END IF;
END
$$;

ALTER TABLE public.resignations
  ADD COLUMN IF NOT EXISTS row_version integer;

ALTER TABLE public.terminations
  ADD COLUMN IF NOT EXISTS row_version integer;

UPDATE public.resignations
SET row_version = 1
WHERE row_version IS NULL;

UPDATE public.terminations
SET row_version = 1
WHERE row_version IS NULL;

ALTER TABLE public.resignations
  ALTER COLUMN row_version SET DEFAULT 1;

ALTER TABLE public.terminations
  ALTER COLUMN row_version SET DEFAULT 1;
