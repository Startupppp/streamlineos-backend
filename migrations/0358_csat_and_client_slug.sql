SET statement_timeout = 0;
-- 0358 — CLIENT → CLIENT_USER role slug data migration
-- =============================================================================
-- H-25 decision: the `csat` module is kept as a distinct CRM-native product
-- concept. No schema changes are required here; see the report for full
-- rationale (csat_surveys/csat_responses are read by three production services,
-- the schema is structurally unlike survey_forms, and clientId linkage is
-- unique to this concept). This migration file covers only M-15.
--
-- M-15: rename the `CLIENT` role slug to `CLIENT_USER` to match
-- ROLE_DEFAULT_PERMISSIONS and the role-templates catalog, which were updated
-- in code but not applied to existing database rows.
--
-- Guard: only rows whose slug is exactly 'CLIENT' are touched.
-- Collision handling: if the org already has a row with slug 'CLIENT_USER',
-- the 'CLIENT' row is LEFT UNCHANGED for that org (renaming would violate the
-- unique index uniq_role_slug_org on (slug, org_id)). Collision orgs will
-- retain an orphaned 'CLIENT' role; an operator must resolve those manually
-- by inspecting role_assignments referencing that role and deciding whether
-- to merge grants or drop the role.
-- =============================================================================

UPDATE roles
SET slug = 'CLIENT_USER'
WHERE slug = 'CLIENT'
  AND NOT EXISTS (
    SELECT 1
    FROM roles r2
    WHERE r2.org_id = roles.org_id
      AND r2.slug = 'CLIENT_USER'
  );
