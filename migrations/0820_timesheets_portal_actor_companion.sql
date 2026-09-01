-- 0820_timesheets_portal_actor_companion
-- Add membership-id companions for the five timesheet owner columns and the one
-- portal membership column.  Each follows the exact pattern established by 0807,
-- 0809 and 0815: ADD COLUMN nullable → backfill JOIN → ADD FK NOT VALID →
-- VALIDATE → CREATE INDEX.
--
-- Tables covered:
--   timesheets               user_id → user_membership_id
--   timesheet_exceptions     user_id → user_membership_id
--   timesheet_periods        user_id → user_membership_id
--   timesheet_rates          user_id → user_membership_id
--   timer_sessions           user_id → user_membership_id
--   portal_memberships       user_id → user_membership_id  (org col: organization_id)

SET lock_timeout = '5s';
SET statement_timeout = 0;
--> statement-breakpoint

-- ── timesheets ──────────────────────────────────────────────────────────────

ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE timesheets t
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheets_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheets
      ADD CONSTRAINT fk_timesheets_user_membership
      FOREIGN KEY (org_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE timesheets VALIDATE CONSTRAINT fk_timesheets_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timesheets_org_user_membership
  ON timesheets (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── timesheet_exceptions (user_id) ──────────────────────────────────────────

ALTER TABLE timesheet_exceptions ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE timesheet_exceptions t
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheet_exceptions_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheet_exceptions
      ADD CONSTRAINT fk_timesheet_exceptions_user_membership
      FOREIGN KEY (org_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE timesheet_exceptions VALIDATE CONSTRAINT fk_timesheet_exceptions_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timesheet_exceptions_org_user_membership
  ON timesheet_exceptions (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── timesheet_periods (user_id) ──────────────────────────────────────────────

ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE timesheet_periods t
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheet_periods_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheet_periods
      ADD CONSTRAINT fk_timesheet_periods_user_membership
      FOREIGN KEY (org_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE timesheet_periods VALIDATE CONSTRAINT fk_timesheet_periods_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timesheet_periods_org_user_membership
  ON timesheet_periods (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── timesheet_rates (user_id) ────────────────────────────────────────────────

ALTER TABLE timesheet_rates ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE timesheet_rates t
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheet_rates_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheet_rates
      ADD CONSTRAINT fk_timesheet_rates_user_membership
      FOREIGN KEY (org_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE timesheet_rates VALIDATE CONSTRAINT fk_timesheet_rates_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timesheet_rates_org_user_membership
  ON timesheet_rates (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── timer_sessions (user_id) ─────────────────────────────────────────────────

ALTER TABLE timer_sessions ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE timer_sessions t
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timer_sessions_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timer_sessions
      ADD CONSTRAINT fk_timer_sessions_user_membership
      FOREIGN KEY (org_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE timer_sessions VALIDATE CONSTRAINT fk_timer_sessions_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timer_sessions_org_user_membership
  ON timer_sessions (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── portal_memberships (user_id, tenant col: organization_id) ────────────────

ALTER TABLE portal_memberships ADD COLUMN IF NOT EXISTS user_membership_id integer;
--> statement-breakpoint

UPDATE portal_memberships p
SET user_membership_id = om.id
FROM organization_members om
WHERE om.org_id = p.organization_id
  AND om.user_id = p.user_id
  AND p.user_membership_id IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_portal_memberships_user_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE portal_memberships
      ADD CONSTRAINT fk_portal_memberships_user_membership
      FOREIGN KEY (organization_id, user_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (user_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE portal_memberships VALIDATE CONSTRAINT fk_portal_memberships_user_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_portal_memberships_org_user_membership
  ON portal_memberships (organization_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

-- ── Self-verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(col, ', ') INTO missing
  FROM (VALUES
    ('timesheets', 'user_membership_id'),
    ('timesheet_exceptions', 'user_membership_id'),
    ('timesheet_periods', 'user_membership_id'),
    ('timesheet_rates', 'user_membership_id'),
    ('timer_sessions', 'user_membership_id'),
    ('portal_memberships', 'user_membership_id')
  ) AS t(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0820: companion columns not present: %', missing;
  END IF;

  SELECT string_agg(c.conname, ', ') INTO missing
  FROM pg_constraint c
  WHERE c.conname IN (
    'fk_timesheets_user_membership',
    'fk_timesheet_exceptions_user_membership',
    'fk_timesheet_periods_user_membership',
    'fk_timesheet_rates_user_membership',
    'fk_timer_sessions_user_membership',
    'fk_portal_memberships_user_membership'
  )
    AND c.contype = 'f'
    AND (c.confdeltype <> 'n' OR c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0820: composite ON DELETE SET NULL without a single-column list (would null org_id / organization_id): %', missing;
  END IF;
END $$;
