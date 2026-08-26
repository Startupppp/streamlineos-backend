-- 0488_hr_people_drop_identity_cols
-- Ticket: c16-01 — one table owns a person's identity
--
-- NOT JOURNALLED — deliberately excluded from migrations/meta/_journal.json.
-- Dropping a column rewrites the table (ACCESS EXCLUSIVE lock) and cannot be
-- undone if the copy in migration 0486 turned out to be wrong.  Apply this
-- migration manually only after:
--   1. Migration 0487 (VALIDATE CONSTRAINT) has succeeded with zero violations.
--   2. All call-sites outside the owned trees that read identity from hr_people
--      have been updated to read from organization_people instead.  See the
--      ticket comment for the list of those call-sites.
--   3. The new code reading identity via the JOIN has been deployed and confirmed
--      working in production.
-- VACUUM ANALYZE hr_people immediately after running this migration.

SET lock_timeout = '5s';

ALTER TABLE hr_people
  DROP COLUMN IF EXISTS first_name,
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS work_email,
  DROP COLUMN IF EXISTS personal_email,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS gender,
  DROP COLUMN IF EXISTS nationality,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS emergency_contact,
  DROP COLUMN IF EXISTS avatar_url;
