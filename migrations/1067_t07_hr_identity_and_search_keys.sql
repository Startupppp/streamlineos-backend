SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 1067 — the two identity keys the HR directory already assumes, and the one
--        search index its ILIKE fallback is missing.
--
-- All three objects were verified ABSENT against pg_indexes on a database at
-- journal head (scratch_gates_head, 685/685), not inferred from the Drizzle
-- declaration:
--
--   hr_employments  pkey, uniq_hr_employments_org_id, uniq_hr_employments_org_id_person,
--                   uniq_hr_employments_org_emp_num, idx_hr_employments_person,
--                   idx_hr_employments_org_status, idx_hr_employments_org_live_status,
--                   idx_hr_employments_custom_field_values_gin
--   hr_people       pkey, uniq_hr_people_org_id, uniq_hr_people_org_person_link,
--                   idx_hr_people_org, idx_hr_people_org_live, idx_hr_people_user
--   users (trgm)    idx_users_name_trgm, idx_users_email_trgm, idx_users_first_name_trgm
--
-- Nothing on that list constrains (org_id, person_id) WHERE is_primary, nothing
-- constrains (org_id, user_id), and last_name has no trigram index.
--
-- ============================================================================
-- 1. ONE LIVE PRIMARY EMPLOYMENT PER PERSON.
--
-- `hr_employments.is_primary` defaults to true. HrEmploymentsService.create
-- (modules/hr/core/hr-employments.service.ts) now selects any existing live
-- primary and inserts `isPrimary: !existingPrimary`, which is a check-then-insert:
-- two concurrent creates for the same person both read zero and both insert a
-- primary. The fix's own spec says so in its header
-- (core/__tests__/hr-employments-primary-uniqueness.spec.ts) — "There is still no
-- partial unique index enforcing this in the database".
--
-- The consequence is not cosmetic. The directory join
-- (organization_members -> users -> live hr_people -> primary hr_employments,
-- modules/directory/employment-query.ts) carries no DISTINCT, so a second live
-- primary returns that employee TWICE from GET /hr/employees, shortens the keyset
-- page by one real employee, and adds one to every count()-based headcount.
--
-- PARTIAL, on purpose, and org_id LEADS. hr_employments is RLS-enabled
-- (relrowsecurity = t), and backend/CLAUDE.md section 7 makes org_id mandatory in
-- the leading position of an index on such a table: the policy qual is not
-- leakproof, so it is evaluated against the heap tuple and the planner refuses an
-- index that cannot supply org_id itself. The predicate excludes soft-deleted rows
-- and non-primary rows, because plural employments per person are the design —
-- only the PRIMARY one is singular.
--
-- The pre-flight RAISES rather than de-duplicating (1052's precedent). Which of
-- two primaries is the real one is a business question this file cannot answer,
-- and silently demoting the wrong one moves the reporting error rather than
-- fixing it. Measured on scratch_gates_head: 0 offending groups over 5,673 rows.
-- ============================================================================

DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM (
    SELECT org_id, person_id
    FROM hr_employments
    WHERE is_primary AND deleted_at IS NULL
    GROUP BY org_id, person_id
    HAVING count(*) > 1
  ) duplicates;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'hr_employments holds % (org_id, person_id) group(s) with more than one live primary employment. '
      'Resolve them before applying 1067: SELECT org_id, person_id, array_agg(id) FROM hr_employments '
      'WHERE is_primary AND deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;', offending;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_employments_org_person_primary
  ON hr_employments (org_id, person_id)
  WHERE is_primary AND deleted_at IS NULL;

-- ============================================================================
-- 2. ONE LIVE HR PERSON PER (ORGANISATION, USER).
--
-- PersonEmploymentSyncService.ensureFromUser
-- (modules/hr/core/person-employment-sync.service.ts) reads hr_people by
-- (org_id, user_id, deleted_at IS NULL) and inserts when it finds nothing. There
-- is no lock and no unique index, so two concurrent onboarding or import paths
-- for the same user both read nothing and both insert. Every downstream join goes
-- through `livePersonOfUser`, so a second live person row duplicates that human
-- across the directory, the celebrations feed and the payroll input snapshot.
--
-- uniq_hr_people_org_person_link already constrains (org_id, organization_person_id)
-- WHERE organization_person_id IS NOT NULL. That is the ORGANISATION-PEOPLE leg,
-- a different column and a different nullable pointer; it does not constrain
-- user_id, and a row may carry a user_id with a NULL organization_person_id.
--
-- NULLS stay DISTINCT (the default): user_id is nullable and a person with no
-- login is legitimate (backend/CLAUDE.md section 1 — organization_people is the
-- person; a login is one facet). NULLS NOT DISTINCT would collapse every
-- loginless person in an organisation into one row.
-- ============================================================================

DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM (
    SELECT org_id, user_id
    FROM hr_people
    WHERE user_id IS NOT NULL AND deleted_at IS NULL
    GROUP BY org_id, user_id
    HAVING count(*) > 1
  ) duplicates;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'hr_people holds % (org_id, user_id) group(s) with more than one live person row. '
      'Resolve them before applying 1067: SELECT org_id, user_id, array_agg(id) FROM hr_people '
      'WHERE user_id IS NOT NULL AND deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;', offending;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_people_org_user_live
  ON hr_people (org_id, user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- 3. THE FOURTH TRIGRAM INDEX THE EMPLOYEE SEARCH FALLBACK NEEDS.
--
-- EmployeesService.searchCondition (modules/hr/directory/employees.service.ts)
-- runs app.search_hr_person_ids first and, above EMPLOYEE_SEARCH_CAP, falls back
-- to a four-column ILIKE: users.name, users.email, users.first_name and
-- users.last_name. 0007_search_trgm_indexes.sql created gin_trgm_ops indexes for
-- the first three and not the fourth, so the fallback's last leg is a sequential
-- scan of the global users table on every over-cap search.
--
-- users is NOT RLS-enabled (relrowsecurity = f, confirmed on scratch_gates_head),
-- which is why a trigram index is usable here at all: backend/CLAUDE.md section 3's
-- warning that a text index is unusable under RLS — the operator is not leakproof,
-- so the RLS qual runs first and the index is skipped — does not apply to this
-- table. That is also why this is an ordinary CREATE INDEX and not another
-- SECURITY DEFINER resolver.
--
-- pg_trgm is present at journal head (pg_extension, confirmed), and the cold-build
-- rules create it before db:migrate, so no CREATE EXTENSION belongs here.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_last_name_trgm
  ON users USING gin (last_name gin_trgm_ops);
