-- 0488_hr_people_drop_identity_cols
-- Ticket: c16-01 — one table owns a person's identity
--
-- NOT JOURNALLED — deliberately excluded from migrations/meta/_journal.json.
--
-- PEND-DB confirmed that and left it out. It was briefly added while fixing the
-- cold build, because fifteen files were missing from the journal and most of
-- them were missing by accident; this one is missing on purpose, and it is the
-- only one of the fifteen that says so. Preconditions 2 and 3 below are not
-- things a migration pass can verify — `src/db/schema/hr/` no longer declares
-- these columns, which satisfies the letter of 2, but "confirmed working in
-- production" is somebody's judgement and not a grep.
--
-- `crm-legacy-readers.spec.ts` lists this alongside 0278 as an outstanding
-- manual step, so it stays visible rather than becoming an orphan nobody
-- remembers.
-- Dropping a column rewrites the table (ACCESS EXCLUSIVE lock) and cannot be
-- undone if the copy in migration 0486 turned out to be wrong.
--
-- It was wrong.  0486 phase C carries three columns into organization_people
-- --- first_name, last_name, work_email --- and this migration drops eleven.
-- The other eight (personal_email, phone, date_of_birth, gender, nationality,
-- address, emergency_contact, avatar_url) had no copy in organization_people
-- or anywhere else, so running this against real rows destroyed them silently.
-- Migration 0820 finishes the copy and then verifies it finished, aborting on
-- an unlinked live row or on two hr_people rows disagreeing about one person.
-- 0820 is journalled, so it runs ahead of any manual application of this file.
--
-- Apply this migration manually only after:
--   1. Migration 0487 (VALIDATE CONSTRAINT) has succeeded with zero violations,
--      and migration 0820 has run to completion without raising.  0820 is what
--      makes precondition 1 mean "the data is safe" rather than "the link is".
--   2. All call-sites outside the owned trees that read identity from hr_people
--      have been updated to read from organization_people instead.  Satisfied:
--      src/db/schema/hr/ no longer declares these columns and no raw SQL in
--      src/ selects them off hr_people.
--   3. The new code reading identity via the JOIN has been deployed and confirmed
--      working in production.  This one is still somebody's judgement, and it is
--      the only reason this file remains un-journalled.
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
