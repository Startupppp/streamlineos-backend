-- Enforce case-insensitive uniqueness on users.email at the Postgres level.
--
-- The application canonicalises email (trim + lowercase) in the Zod schemas used by every
-- invite, import and direct-create boundary.  That schema-level transform is the primary
-- defence.  This index is the Postgres-level safety net: even if a future entry point forgets
-- the transform, the database refuses to mint a second identity for the same address.
--
-- The existing plain UNIQUE constraint on users.email remains; it is case-sensitive and is now
-- subsumed by this stricter functional index, but dropping it would require a separate
-- schema-snapshot reconciliation step that is out of scope here.
--
-- Duplicate detection
-- -------------------
-- A plain CREATE UNIQUE INDEX fails at the end of the build if existing rows already violate
-- case-insensitive uniqueness, which surfaces as a vague "could not create unique index"
-- with no actionable detail.  The DO block below pre-checks and raises a descriptive error
-- listing every offending canonical address so the operator knows exactly what to resolve.
--
-- Automated merging is intentionally refused: two users rows for the same human means two
-- memberships, two permission sets, two audit trails.  Deciding which account to keep,
-- migrating dependent rows (organization_members, role_assignments, user_delegation*,
-- user_permission_grants, sessions, etc.) and deleting the duplicate is a human data decision.
--
-- If duplicates are found: resolve them manually, then re-run db:migrate.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  dup_count INTEGER;
  dup_list  TEXT;
BEGIN
  SELECT COUNT(*), string_agg(canonical_email, ', ' ORDER BY canonical_email)
  INTO   dup_count, dup_list
  FROM (
    SELECT LOWER(email) AS canonical_email
    FROM   users
    WHERE  email IS NOT NULL
    GROUP  BY LOWER(email)
    HAVING COUNT(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0453 blocked: % canonical email address(es) have case-variant duplicates '
      'in the users table.  Resolve them manually before re-running.  Offending addresses: %',
      dup_count, dup_list;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_users_email_ci" ON "users" (LOWER("email"));
