BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $regression$
DECLARE
  org_a        text;
  created_org  boolean := false;
  parent_a     integer;
  child_a      integer;
  delete_raised_23502 boolean := false;
BEGIN
  SELECT id INTO org_a FROM organizations ORDER BY id LIMIT 1;

  IF org_a IS NULL THEN
    org_a := 'c-regression-org-a';
    created_org := true;
    INSERT INTO organizations (id, name, slug, owner_membership_id)
    VALUES (org_a, 'C Regression Tenant A', 'c-regression-tenant-a', 0);
  END IF;

  ALTER TABLE job_requisitions
    DROP CONSTRAINT fk_job_requisitions_headcount_org;

  ALTER TABLE job_requisitions
    ADD CONSTRAINT fk_job_requisitions_headcount_org
    FOREIGN KEY (org_id, headcount_id)
    REFERENCES headcount_requests (org_id, id)
    ON DELETE SET NULL;

  INSERT INTO headcount_requests (org_id, requested_by, requested_role)
  VALUES (org_a, 'c-regression', 'Engineer')
  RETURNING id INTO parent_a;

  INSERT INTO job_requisitions (org_id, title, requested_by, headcount_id)
  VALUES (org_a, 'C Regression requisition', 'c-regression', parent_a)
  RETURNING id INTO child_a;

  BEGIN
    DELETE FROM headcount_requests WHERE org_id = org_a AND id = parent_a;
  EXCEPTION
    WHEN not_null_violation THEN
      delete_raised_23502 := true;
  END;

  IF NOT delete_raised_23502 THEN
    RAISE EXCEPTION
      'REGRESSION PROOF FAILED: the bare ON DELETE SET NULL form did NOT raise 23502 on this server. The premise migration 1142 rests on does not hold here; re-derive it before trusting 1142.';
  END IF;

  RAISE NOTICE 'PASS bare-form regression';
  RAISE NOTICE '  with 1128a''s bare ON DELETE SET NULL restored, deleting parent % raised 23502 on job_requisitions.org_id', parent_a;
  RAISE NOTICE '  this is the failure migration 1142 removes; org created by this proof = %', created_org;
END
$regression$;

ROLLBACK;
