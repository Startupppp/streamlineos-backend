\set ON_ERROR_STOP on
\timing on

\echo 'BLOCK 1 - 1141 forward, assert catalog changed, roll back'
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'build' AND c.relname = 'projects'
      AND a.attname = 'pm_workspace_id' AND a.attnotnull
  ) THEN
    RAISE NOTICE 'PRECONDITION: build.projects.pm_workspace_id is ALREADY nullable, 1141 appears applied on this target';
  ELSE
    RAISE NOTICE 'PRECONDITION OK: build.projects.pm_workspace_id is NOT NULL, 1141 is unapplied on this target';
  END IF;
END $$;

ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'build' AND c.relname = 'projects'
      AND a.attname = 'pm_workspace_id' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '1141 FORWARD FAILED: attnotnull still true after DROP NOT NULL';
  END IF;
  RAISE NOTICE '1141 FORWARD OK: attnotnull cleared on build.projects.pm_workspace_id';
END $$;

ROLLBACK;

\echo 'BLOCK 2 - 1141 forward then its rollback script, proving NOT NULL is restorable'
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" DROP NOT NULL;

ALTER TABLE "build"."projects"
  ADD CONSTRAINT "chk_projects_pm_workspace_id_not_null"
  CHECK ("pm_workspace_id" IS NOT NULL) NOT VALID;

ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "chk_projects_pm_workspace_id_not_null";

ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" SET NOT NULL;

ALTER TABLE "build"."projects" DROP CONSTRAINT "chk_projects_pm_workspace_id_not_null";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'build' AND c.relname = 'projects'
      AND a.attname = 'pm_workspace_id' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '1141 REVERSE FAILED: NOT NULL was not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_pm_workspace_id_not_null') THEN
    RAISE EXCEPTION '1141 REVERSE FAILED: scaffolding check constraint left behind';
  END IF;
  RAISE NOTICE '1141 REVERSE OK: NOT NULL restored, no scaffolding constraint remains';
END $$;

ROLLBACK;

\echo 'BLOCK 3 - 1142 forward, assert confdelsetcols is exactly headcount_id, roll back'
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  cols text;
BEGIN
  SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '<none>')
    INTO cols
  FROM pg_constraint k
  LEFT JOIN LATERAL unnest(k.confdelsetcols) AS s(attnum) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = s.attnum
  WHERE k.conname = 'fk_job_requisitions_headcount_org';
  RAISE NOTICE 'PRECONDITION: fk_job_requisitions_headcount_org confdelsetcols = %', cols;
END $$;

ALTER TABLE "job_requisitions"
  DROP CONSTRAINT "fk_job_requisitions_headcount_org";

ALTER TABLE "job_requisitions"
  ADD CONSTRAINT "fk_job_requisitions_headcount_org"
  FOREIGN KEY ("org_id", "headcount_id")
  REFERENCES "headcount_requests"("org_id", "id")
  ON DELETE SET NULL ("headcount_id")
  NOT VALID;

ALTER TABLE "job_requisitions" VALIDATE CONSTRAINT "fk_job_requisitions_headcount_org";

DO $$
DECLARE
  cols text;
  validated boolean;
BEGIN
  SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '<none>'), bool_and(k.convalidated)
    INTO cols, validated
  FROM pg_constraint k
  LEFT JOIN LATERAL unnest(k.confdelsetcols) AS s(attnum) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = s.attnum
  WHERE k.conname = 'fk_job_requisitions_headcount_org';

  IF cols IS DISTINCT FROM 'headcount_id' THEN
    RAISE EXCEPTION '1142 FORWARD FAILED: confdelsetcols = %, expected headcount_id', cols;
  END IF;
  IF NOT validated THEN
    RAISE EXCEPTION '1142 FORWARD FAILED: constraint still NOT VALID after VALIDATE';
  END IF;
  RAISE NOTICE '1142 FORWARD OK: confdelsetcols = headcount_id and the constraint is validated';
END $$;

ROLLBACK;

\echo 'BLOCK 4 - behavioural proof that a headcount parent delete no longer raises 23502'
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "job_requisitions"
  DROP CONSTRAINT "fk_job_requisitions_headcount_org";

ALTER TABLE "job_requisitions"
  ADD CONSTRAINT "fk_job_requisitions_headcount_org"
  FOREIGN KEY ("org_id", "headcount_id")
  REFERENCES "headcount_requests"("org_id", "id")
  ON DELETE SET NULL ("headcount_id")
  NOT VALID;

DO $$
DECLARE
  target_org text;
  target_headcount integer;
  affected int;
BEGIN
  SELECT r.org_id, r.headcount_id INTO target_org, target_headcount
  FROM job_requisitions r
  WHERE r.headcount_id IS NOT NULL
  LIMIT 1;

  IF target_headcount IS NULL THEN
    RAISE NOTICE '1142 BEHAVIOUR SKIPPED: no job_requisitions row references a headcount_request on this target';
    RETURN;
  END IF;

  DELETE FROM headcount_requests WHERE org_id = target_org AND id = target_headcount;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected = 0 THEN
    RAISE NOTICE '1142 BEHAVIOUR SKIPPED: parent row was not deletable on this target';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM job_requisitions WHERE org_id = target_org AND headcount_id = target_headcount) THEN
    RAISE EXCEPTION '1142 BEHAVIOUR FAILED: child still points at the deleted parent';
  END IF;

  RAISE NOTICE '1142 BEHAVIOUR OK: parent delete succeeded and the child pointer was nulled without 23502';
END $$;

ROLLBACK;

\echo 'BLOCK 5 - control proving the pre-repair bare SET NULL really does raise 23502'
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "job_requisitions"
  DROP CONSTRAINT "fk_job_requisitions_headcount_org";

ALTER TABLE "job_requisitions"
  ADD CONSTRAINT "fk_job_requisitions_headcount_org"
  FOREIGN KEY ("org_id", "headcount_id")
  REFERENCES "headcount_requests"("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;

DO $$
DECLARE
  target_org text;
  target_headcount integer;
BEGIN
  SELECT r.org_id, r.headcount_id INTO target_org, target_headcount
  FROM job_requisitions r
  WHERE r.headcount_id IS NOT NULL
  LIMIT 1;

  IF target_headcount IS NULL THEN
    RAISE NOTICE 'PRE-REPAIR CONTROL SKIPPED: no referencing row on this target';
    RETURN;
  END IF;

  BEGIN
    DELETE FROM headcount_requests WHERE org_id = target_org AND id = target_headcount;
    RAISE EXCEPTION 'PRE-REPAIR CONTROL FAILED: bare SET NULL delete unexpectedly SUCCEEDED, so the premise of 1142 does not hold on this target';
  EXCEPTION
    WHEN not_null_violation THEN
      RAISE NOTICE 'PRE-REPAIR CONTROL OK: bare SET NULL raised 23502 as expected, confirming 1142 is load bearing';
  END;
END $$;

ROLLBACK;
