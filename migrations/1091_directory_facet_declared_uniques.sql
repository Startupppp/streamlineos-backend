SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  duplicate_count integer;
  sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s) x%s', d.organization_id, d.email_key, d.n), '; '), '')
    INTO duplicate_count, sample
    FROM (
      SELECT organization_id, lower(work_email) AS email_key, count(*) AS n
        FROM organization_people
       WHERE work_email IS NOT NULL
         AND archived_at IS NULL
         AND deleted_at IS NULL
       GROUP BY organization_id, lower(work_email)
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'organization_people has % case-insensitive duplicate live work_email group(s); uniq_org_people_active_work_email_ci cannot be created until they are resolved. First groups: %',
      duplicate_count, sample
      USING HINT = 'Decide which organization_people row survives per group and repoint hr_people / workers / hr_employments at it, or archive the losers, before re-running. Do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_people_active_work_email_ci"
  ON "organization_people" ("organization_id", lower("work_email"))
  WHERE "work_email" IS NOT NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  duplicate_count integer;
  sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s) x%s', d.organization_id, d.worker_number, d.n), '; '), '')
    INTO duplicate_count, sample
    FROM (
      SELECT organization_id, worker_number, count(*) AS n
        FROM workers
       WHERE worker_number IS NOT NULL
         AND archived_at IS NULL
         AND deleted_at IS NULL
       GROUP BY organization_id, worker_number
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'workers has % duplicated (organization_id, worker_number) pair(s) among live rows; uniq_workers_active_org_number cannot be created until they are resolved. First pairs: %',
      duplicate_count, sample
      USING HINT = 'Renumber or archive the losing worker rows before re-running. worker_engagements and hr_employments reference workers, so do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workers_active_org_number"
  ON "workers" ("organization_id", "worker_number")
  WHERE "worker_number" IS NOT NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  duplicate_count integer;
  sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s) x%s', d.org_id, d.worker_engagement_id, d.n), '; '), '')
    INTO duplicate_count, sample
    FROM (
      SELECT org_id, worker_engagement_id, count(*) AS n
        FROM hr_employments
       WHERE worker_engagement_id IS NOT NULL
       GROUP BY org_id, worker_engagement_id
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'hr_employments has % duplicated (org_id, worker_engagement_id) pair(s); uniq_hr_employments_org_engagement_link cannot be created until they are resolved. First pairs: %',
      duplicate_count, sample
      USING HINT = 'One engagement backs at most one employment. Decide which hr_employments row keeps the engagement and null the other link before re-running. Do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_employments_org_engagement_link"
  ON "hr_employments" ("org_id", "worker_engagement_id")
  WHERE "worker_engagement_id" IS NOT NULL;
