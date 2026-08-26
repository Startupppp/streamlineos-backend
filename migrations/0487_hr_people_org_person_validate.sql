-- 0487_hr_people_org_person_validate
-- Ticket: c16-01 — one table owns a person's identity
--
-- Validates the FK constraint added NOT VALID in migration 0486.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (online-safe; concurrent reads
-- and writes continue).  It will fail if any non-null organization_person_id
-- in hr_people references a row that does not exist in organization_people — which
-- means the phase-A/D backfill in 0486 did not fully resolve a dangling link.
-- In that case fix the orphan before re-running this migration.

SET lock_timeout = '5s';

ALTER TABLE hr_people
  VALIDATE CONSTRAINT fk_hr_people_org_person;
