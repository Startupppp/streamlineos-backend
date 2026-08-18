BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2min';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = public, pg_catalog;

SELECT
  current_database() AS database_name,
  current_user AS database_role,
  current_setting('server_version_num')::integer AS server_version_num,
  current_setting('app.environment', true) AS configured_environment,
  current_setting('transaction_read_only')::boolean AS read_only;

SELECT source_table, row_count
FROM (
  SELECT 'organizations'::text, count(*)::bigint FROM organizations
  UNION ALL SELECT 'organization_members', count(*) FROM organization_members
  UNION ALL SELECT 'organization_people', count(*) FROM organization_people
  UNION ALL SELECT 'workers', count(*) FROM workers
  UNION ALL SELECT 'worker_engagements', count(*) FROM worker_engagements
  UNION ALL SELECT 'hr_people', count(*) FROM hr_people
  UNION ALL SELECT 'hr_employments', count(*) FROM hr_employments
  UNION ALL SELECT 'leave_balances', count(*) FROM leave_balances
  UNION ALL SELECT 'leave_requests', count(*) FROM leave_requests
  UNION ALL SELECT 'hr_leave_ledger', count(*) FROM hr_leave_ledger
  UNION ALL SELECT 'attendance', count(*) FROM attendance
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
) inventory(source_table, row_count)
ORDER BY source_table;

WITH duplicate_groups AS (
  SELECT
    organization_id,
    lower(btrim(work_email)) AS normalized_email,
    array_agg(organization_person_id ORDER BY organization_person_id) AS person_ids,
    count(*)::integer AS duplicate_count
  FROM organization_people
  WHERE work_email IS NOT NULL
    AND btrim(work_email) <> ''
  GROUP BY organization_id, lower(btrim(work_email))
  HAVING count(*) > 1
), id_only_manifest AS (
  SELECT
    organization_id,
    row_number() OVER (
      PARTITION BY organization_id
      ORDER BY person_ids[1]
    ) AS duplicate_group_ordinal,
    person_ids,
    duplicate_count
  FROM duplicate_groups
)
SELECT *
FROM id_only_manifest
ORDER BY organization_id, duplicate_group_ordinal;

SELECT
  member.org_id AS organization_id,
  member.id AS membership_id,
  member.user_id,
  CASE
    WHEN person.organization_person_id IS NULL THEN 'ACCESS_ONLY_CANDIDATE'
    WHEN worker.worker_id IS NULL THEN 'PERSON_ONLY_CANDIDATE'
    WHEN engagement.worker_engagement_id IS NULL THEN 'WORKER_WITHOUT_ENGAGEMENT'
    ELSE 'WORKFORCE_SUBJECT_CANDIDATE'
  END AS classification_candidate
FROM organization_members member
LEFT JOIN organization_people person
  ON person.organization_id = member.org_id
 AND (
   person.organization_membership_id = member.id
   OR person.user_id = member.user_id
 )
LEFT JOIN workers worker
  ON worker.organization_id = person.organization_id
 AND worker.organization_person_id = person.organization_person_id
LEFT JOIN worker_engagements engagement
  ON engagement.organization_id = worker.organization_id
 AND engagement.worker_id = worker.worker_id
WHERE member.status = 'ACTIVE'
ORDER BY member.org_id, member.id, engagement.worker_engagement_id;

SELECT edge_kind, source_id, source_organization_id, target_organization_id
FROM (
  SELECT
    'PERSON_MEMBERSHIP_TENANT'::text AS edge_kind,
    person.organization_person_id AS source_id,
    person.organization_id AS source_organization_id,
    member.org_id AS target_organization_id
  FROM organization_people person
  JOIN organization_members member
    ON member.id = person.organization_membership_id
  WHERE member.org_id <> person.organization_id
  UNION ALL
  SELECT
    'WORKER_PERSON_TENANT',
    worker.worker_id,
    worker.organization_id,
    person.organization_id
  FROM workers worker
  JOIN organization_people person
    ON person.organization_person_id = worker.organization_person_id
  WHERE person.organization_id <> worker.organization_id
  UNION ALL
  SELECT
    'ENGAGEMENT_WORKER_TENANT',
    engagement.worker_engagement_id,
    engagement.organization_id,
    worker.organization_id
  FROM worker_engagements engagement
  JOIN workers worker ON worker.worker_id = engagement.worker_id
  WHERE worker.organization_id <> engagement.organization_id
  UNION ALL
  SELECT
    'HR_EMPLOYMENT_PERSON_TENANT',
    employment.id::text,
    employment.org_id,
    person.org_id
  FROM hr_employments employment
  JOIN hr_people person ON person.id = employment.person_id
  WHERE person.org_id <> employment.org_id
) invalid_edges
ORDER BY edge_kind, source_organization_id, source_id;

SELECT
  'PERSON_MEMBERSHIP_USER_MISMATCH' AS issue_kind,
  person.organization_id,
  person.organization_person_id AS source_id,
  person.user_id AS person_user_id,
  member.user_id AS membership_user_id
FROM organization_people person
JOIN organization_members member
  ON member.id = person.organization_membership_id
WHERE person.user_id IS NOT NULL
  AND person.user_id <> member.user_id
ORDER BY person.organization_id, person.organization_person_id;

SELECT
  organization_id,
  timezone,
  count(*)::integer AS organization_count
FROM (
  SELECT id AS organization_id, timezone FROM organizations
) organization_timezones
GROUP BY organization_id, timezone
ORDER BY organization_id;

SELECT
  source_name,
  month_key,
  source_rows
FROM (
  SELECT
    'attendance.date'::text AS source_name,
    to_char(date_trunc('month', date::timestamp), 'YYYY-MM') AS month_key,
    count(*)::bigint AS source_rows
  FROM attendance
  GROUP BY date_trunc('month', date::timestamp)
  UNION ALL
  SELECT
    'hr_leave_ledger.effective_date',
    to_char(date_trunc('month', effective_date::timestamp), 'YYYY-MM'),
    count(*)
  FROM hr_leave_ledger
  GROUP BY date_trunc('month', effective_date::timestamp)
  UNION ALL
  SELECT
    'leave_requests.start_date',
    to_char(date_trunc('month', start_date::timestamp), 'YYYY-MM'),
    count(*)
  FROM leave_requests
  GROUP BY date_trunc('month', start_date::timestamp)
  UNION ALL
  SELECT
    'audit_logs.created_at_ambiguous',
    to_char(date_trunc('month', created_at), 'YYYY-MM'),
    count(*)
  FROM audit_logs
  GROUP BY date_trunc('month', created_at)
) month_manifest
ORDER BY source_name, month_key;

SELECT
  count(*)::integer AS leave_balance_rows,
  coalesce(sum(balance), 0)::numeric AS leave_balance_days
FROM leave_balances;

ROLLBACK;
