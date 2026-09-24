BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $proof$
DECLARE
  supplied      text[] := ARRAY[
                            'organizations.id', 'organizations.name', 'organizations.slug',
                            'organizations.owner_membership_id',
                            'headcount_requests.org_id', 'headcount_requests.requested_by',
                            'headcount_requests.requested_role',
                            'job_requisitions.org_id', 'job_requisitions.title',
                            'job_requisitions.requested_by'
                          ];
  unhandled     text;
  setcols       text[];
  org_a         text;
  org_b         text;
  created_orgs  boolean := false;
  parent_a      integer;
  parent_b      integer;
  child_a       integer;
  child_b       integer;
  a_headcount   integer;
  a_org         text;
  b_headcount   integer;
  b_org         text;
  cross_tenant_insert_succeeded boolean := false;
BEGIN
  SELECT array_agg(att.attname::text ORDER BY att.attname)
    INTO setcols
    FROM pg_constraint con
   CROSS JOIN LATERAL unnest(con.confdelsetcols) AS s(attnum)
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum   = s.attnum
   WHERE con.conname = 'fk_job_requisitions_headcount_org'
     AND con.contype = 'f';

  IF setcols IS DISTINCT FROM ARRAY['headcount_id']::text[] THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: fk_job_requisitions_headcount_org carries confdelsetcols %, expected {headcount_id}. Migration 1142 is not applied to this database, or 1128a''s bare form is still standing.',
      coalesce(setcols::text, 'NULL');
  END IF;

  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name)
    INTO unhandled
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name IN ('organizations', 'headcount_requests', 'job_requisitions')
     AND c.is_nullable = 'NO'
     AND c.column_default IS NULL
     AND c.is_identity = 'NO'
     AND (c.table_name || '.' || c.column_name) <> ALL (supplied);

  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: these NOT NULL columns have no default and are not supplied by this proof: %. Add them to the INSERTs below before running.',
      unhandled;
  END IF;

  SELECT min(id), max(id) INTO org_a, org_b
    FROM (SELECT id FROM organizations ORDER BY id LIMIT 2) AS two_orgs;

  IF org_a IS NULL OR org_b IS NULL OR org_a = org_b THEN
    org_a := 'c-proof-org-a';
    org_b := 'c-proof-org-b';
    created_orgs := true;
    INSERT INTO organizations (id, name, slug, owner_membership_id)
    VALUES (org_a, 'C Proof Tenant A', 'c-proof-tenant-a', 0),
           (org_b, 'C Proof Tenant B', 'c-proof-tenant-b', 0);
  END IF;

  INSERT INTO headcount_requests (org_id, requested_by, requested_role)
  VALUES (org_a, 'c-proof', 'Engineer')
  RETURNING id INTO parent_a;

  INSERT INTO headcount_requests (org_id, requested_by, requested_role)
  VALUES (org_b, 'c-proof', 'Engineer')
  RETURNING id INTO parent_b;

  INSERT INTO job_requisitions (org_id, title, requested_by, headcount_id)
  VALUES (org_a, 'C Proof requisition A', 'c-proof', parent_a)
  RETURNING id INTO child_a;

  INSERT INTO job_requisitions (org_id, title, requested_by, headcount_id)
  VALUES (org_b, 'C Proof requisition B', 'c-proof', parent_b)
  RETURNING id INTO child_b;

  BEGIN
    INSERT INTO job_requisitions (org_id, title, requested_by, headcount_id)
    VALUES (org_b, 'C Proof cross-tenant reference', 'c-proof', parent_a);
    cross_tenant_insert_succeeded := true;
  EXCEPTION
    WHEN foreign_key_violation THEN
      cross_tenant_insert_succeeded := false;
  END;

  IF cross_tenant_insert_succeeded THEN
    RAISE EXCEPTION
      'CROSS-TENANT FAILURE: a job_requisitions row in org % was accepted while pointing at headcount_request % which belongs to org %. The composite key is not tenant-scoped.',
      org_b, parent_a, org_a;
  END IF;

  DELETE FROM headcount_requests WHERE org_id = org_a AND id = parent_a;

  SELECT headcount_id, org_id INTO a_headcount, a_org
    FROM job_requisitions WHERE id = child_a;

  SELECT headcount_id, org_id INTO b_headcount, b_org
    FROM job_requisitions WHERE id = child_b;

  IF a_headcount IS NOT NULL THEN
    RAISE EXCEPTION
      'ACTION FAILED: org A child % still carries headcount_id % after its parent was deleted. ON DELETE SET NULL did not fire.',
      child_a, a_headcount;
  END IF;

  IF a_org IS DISTINCT FROM org_a THEN
    RAISE EXCEPTION
      'TENANT COLUMN NULLED: org A child % now has org_id %, expected %. The column list did not protect the tenant column.',
      child_a, coalesce(a_org, 'NULL'), org_a;
  END IF;

  IF b_headcount IS DISTINCT FROM parent_b THEN
    RAISE EXCEPTION
      'CROSS-TENANT FAILURE: deleting a parent in org % changed org % child %''s headcount_id from % to %.',
      org_a, org_b, child_b, parent_b, coalesce(b_headcount::text, 'NULL');
  END IF;

  IF b_org IS DISTINCT FROM org_b THEN
    RAISE EXCEPTION
      'CROSS-TENANT FAILURE: deleting a parent in org % changed org % child %''s org_id to %.',
      org_a, org_b, child_b, coalesce(b_org, 'NULL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM headcount_requests WHERE org_id = org_b AND id = parent_b) THEN
    RAISE EXCEPTION
      'CROSS-TENANT FAILURE: deleting headcount_request % in org % also removed % in org %.',
      parent_a, org_a, parent_b, org_b;
  END IF;

  RAISE NOTICE 'PASS fk_job_requisitions_headcount_org';
  RAISE NOTICE '  tenant A = %, tenant B = %, orgs created by this proof = %', org_a, org_b, created_orgs;
  RAISE NOTICE '  a child in tenant B cannot reference a parent in tenant A (foreign_key_violation raised)';
  RAISE NOTICE '  deleting parent % in tenant A nulled only job_requisitions.headcount_id on child %', parent_a, child_a;
  RAISE NOTICE '  tenant A child org_id survived the delete as %', a_org;
  RAISE NOTICE '  tenant B child % is unchanged: org_id %, headcount_id %', child_b, b_org, b_headcount;
  RAISE NOTICE '  tenant B parent % still exists', parent_b;
END
$proof$;

ROLLBACK;
