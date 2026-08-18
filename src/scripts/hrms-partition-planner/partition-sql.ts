export const installPartitionHelpersSql = `
CREATE OR REPLACE FUNCTION pg_temp.hrms_copy_partition_controls(
  parent_name text,
  child_name text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  parent_oid oid;
  child_oid oid;
  parent_force boolean;
  item record;
  policy_command text;
BEGIN
  SELECT parent.oid, parent.relforcerowsecurity
  INTO parent_oid, parent_force
  FROM pg_class parent
  JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
  WHERE namespace.nspname = 'public' AND parent.relname = parent_name;
  SELECT child.oid
  INTO child_oid
  FROM pg_class child
  JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
  WHERE namespace.nspname = 'public' AND child.relname = child_name;
  IF parent_oid IS NULL OR child_oid IS NULL THEN
    RAISE EXCEPTION 'partition control source or target is missing';
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', child_name);
  IF parent_force THEN
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', child_name);
  ELSE
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', child_name);
  END IF;
  FOR item IN
    SELECT
      policy.polname,
      CASE WHEN policy.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS mode,
      CASE policy.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        ELSE 'ALL'
      END AS command,
      COALESCE((
        SELECT string_agg(
          CASE WHEN role_oid = 0 THEN 'PUBLIC'
               ELSE format('%I', pg_get_userbyid(role_oid)) END,
          ', ' ORDER BY ordinal
        )
        FROM unnest(policy.polroles) WITH ORDINALITY
          AS policy_role(role_oid, ordinal)
      ), 'PUBLIC') AS roles,
      pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
      pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    FROM pg_policy policy
    WHERE policy.polrelid = parent_oid
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy existing
      WHERE existing.polrelid = child_oid AND existing.polname = item.polname
    ) THEN
      policy_command := format(
        'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
        item.polname,
        child_name,
        item.mode,
        item.command,
        item.roles
      );
      IF item.using_expression IS NOT NULL THEN
        policy_command := policy_command || ' USING (' || item.using_expression || ')';
      END IF;
      IF item.check_expression IS NOT NULL THEN
        policy_command := policy_command || ' WITH CHECK (' || item.check_expression || ')';
      END IF;
      EXECUTE policy_command;
    END IF;
  END LOOP;
  FOR item IN
    SELECT
      access.privilege_type,
      CASE WHEN access.grantee = 0 THEN 'PUBLIC'
           ELSE format('%I', pg_get_userbyid(access.grantee)) END AS grantee
    FROM pg_class child
    CROSS JOIN LATERAL aclexplode(
      COALESCE(child.relacl, '{}'::aclitem[])
    ) AS access
    WHERE child.oid = child_oid
  LOOP
    EXECUTE format(
      'REVOKE %s ON TABLE public.%I FROM %s',
      item.privilege_type,
      child_name,
      item.grantee
    );
  END LOOP;
  FOR item IN
    SELECT
      access.privilege_type,
      access.is_grantable,
      CASE WHEN access.grantee = 0 THEN 'PUBLIC'
           ELSE format('%I', pg_get_userbyid(access.grantee)) END AS grantee
    FROM pg_class parent
    CROSS JOIN LATERAL aclexplode(
      COALESCE(parent.relacl, '{}'::aclitem[])
    ) AS access
    WHERE parent.oid = parent_oid
  LOOP
    EXECUTE format(
      'GRANT %s ON TABLE public.%I TO %s%s',
      item.privilege_type,
      child_name,
      item.grantee,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.hrms_create_range_partition(
  parent_name text,
  child_name text,
  lower_bound date,
  upper_bound date
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF parent_name NOT IN (
    'attendance_events',
    'attendance_event_evidence',
    'worker_leave_ledger_entries',
    'hr_audit_events'
  ) THEN
    RAISE EXCEPTION 'range parent is not allowlisted';
  END IF;
  IF child_name !~ ('^' || parent_name || '_y[0-9]{4}m(0[1-9]|1[0-2])$') THEN
    RAISE EXCEPTION 'range child identifier is invalid';
  END IF;
  IF lower_bound >= upper_bound THEN
    RAISE EXCEPTION 'range partition bounds are invalid';
  END IF;

  IF parent_name = 'hr_audit_events' THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
      child_name,
      parent_name,
      lower_bound::text || ' 00:00:00+00',
      upper_bound::text || ' 00:00:00+00'
    );
  ELSE
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
      child_name,
      parent_name,
      lower_bound,
      upper_bound
    );
  END IF;
  PERFORM pg_temp.hrms_copy_partition_controls(parent_name, child_name);
END;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.hrms_create_hash_partition(
  parent_name text,
  child_name text,
  partition_modulus integer,
  partition_remainder integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF parent_name NOT IN (
    'attendance_event_locators',
    'attendance_correction_links',
    'hr_audit_event_sources',
    'worker_leave_entry_locators',
    'worker_leave_reversal_links'
  ) THEN
    RAISE EXCEPTION 'hash parent is not allowlisted';
  END IF;
  IF child_name !~ ('^' || parent_name || '_h[0-9]{2}$') THEN
    RAISE EXCEPTION 'hash child identifier is invalid';
  END IF;
  IF partition_modulus <> 16 THEN
    RAISE EXCEPTION 'hash modulus is invalid';
  END IF;
  IF partition_remainder < 0 OR partition_remainder >= partition_modulus THEN
    RAISE EXCEPTION 'hash remainder is invalid';
  END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
    child_name,
    parent_name,
    partition_modulus,
    partition_remainder
  );
  PERFORM pg_temp.hrms_copy_partition_controls(parent_name, child_name);
END;
$function$;
`;
