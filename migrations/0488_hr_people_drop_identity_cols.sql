-- 0488_hr_people_drop_identity_cols
-- Ticket: c16-01 — one table owns a person's identity
--
-- JOURNALLED, and safe only because 0487a runs immediately before it.
--
-- This file spent a long time deliberately out of the journal: dropping a
-- column rewrites the table under ACCESS EXCLUSIVE and "cannot be undone if the
-- copy in migration 0486 turned out to be wrong", and its third precondition —
-- the new code confirmed working in production — is somebody's judgement and
-- not a grep. `main` made that call in 22ada56e and journalled it.
--
-- The copy in 0486 *was* wrong. 0486 phase C carries three columns into
-- organization_people (first_name, last_name, work_email) and this drops
-- eleven. The other eight — personal_email, phone, date_of_birth, gender,
-- nationality, address, emergency_contact, avatar_url — had no copy in
-- organization_people or anywhere else, and nothing between 0486 and here
-- wrote them. Against an empty database that is invisible; against real rows
-- it is the permanent loss of eight columns of employee personal data.
--
-- 0487a finishes the copy and refuses to report success on anything it could
-- not place: an unlinked live hr_people row, or two rows disagreeing about one
-- person's column, abort the migration with a count. Because it is journalled
-- immediately ahead of this file, the drop below cannot reach a database where
-- the data is not already mirrored — the run fails first.
--
-- Preconditions, restated against what is now true:
--   1. 0487 (VALIDATE CONSTRAINT) succeeds with zero violations, and 0487a runs
--      without raising. 0487a is what makes this mean "the data is safe" rather
--      than only "the link is valid".
--   2. No call-site outside the owned trees reads identity from hr_people.
--      Satisfied: src/db/schema/hr/ no longer declares these columns and no raw
--      SQL in src/ selects them off hr_people.
--   3. The code reading identity via the JOIN is deployed. This is the one that
--      is still judgement; 0487a is the guard that keeps getting it wrong from
--      being unrecoverable.
--
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
