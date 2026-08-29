-- 0486_hr_people_org_person_link
-- Ticket: c16-01 — one table owns a person's identity
--
-- Establishes the real foreign-key from hr_people.organization_person_id
-- to organization_people.(organization_id, organization_person_id).
--
-- Three-phase backfill, then ADD CONSTRAINT NOT VALID:
--   Phase A — null out any dangling (non-null but referencing a missing row)
--   Phase B — link null rows to existing organization_people by email
--   Phase C — create new organization_people rows for still-unlinked hr_people
--   Phase D — link the rows created in phase C
--   Then add the FK NOT VALID (no full-table scan; new inserts are checked immediately)
--
-- Count dangling rows before applying:
--   SELECT COUNT(*) FROM hr_people hp
--   WHERE hp.organization_person_id IS NOT NULL
--     AND hp.deleted_at IS NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM organization_people op
--       WHERE op.organization_id = hp.org_id
--         AND op.organization_person_id = hp.organization_person_id
--     );
--
-- Count null links before applying:
--   SELECT COUNT(*) FROM hr_people
--   WHERE organization_person_id IS NULL AND deleted_at IS NULL;
--
-- VACUUM ANALYZE hr_people after this migration if the table has rows.

SET lock_timeout = '5s';

-- Phase A: clear dangling links so phase B/D can re-establish them via email
UPDATE hr_people hp
SET organization_person_id = NULL
WHERE hp.organization_person_id IS NOT NULL
  AND hp.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM organization_people op
    WHERE op.organization_id = hp.org_id
      AND op.organization_person_id = hp.organization_person_id
  );

-- Phase B: link by email match (case-insensitive)
UPDATE hr_people hp
SET organization_person_id = op.organization_person_id
FROM organization_people op
WHERE hp.organization_person_id IS NULL
  AND hp.deleted_at IS NULL
  AND op.organization_id = hp.org_id
  AND lower(trim(op.work_email)) = lower(trim(hp.work_email))
  AND op.deleted_at IS NULL;

-- Phase C: create canonical records for any still-unlinked hr_people rows.
-- ON CONFLICT DO NOTHING handles rows where another case-variant already exists
-- in organization_people; phase D will pick those up.
INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, work_email)
SELECT
  gen_random_uuid()::text,
  hp.org_id,
  hp.first_name,
  hp.last_name,
  lower(trim(hp.work_email))
FROM hr_people hp
WHERE hp.organization_person_id IS NULL
  AND hp.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Phase D: link again after phase C insertions (also catches phase C conflicts)
UPDATE hr_people hp
SET organization_person_id = op.organization_person_id
FROM organization_people op
WHERE hp.organization_person_id IS NULL
  AND hp.deleted_at IS NULL
  AND op.organization_id = hp.org_id
  AND lower(trim(op.work_email)) = lower(trim(hp.work_email))
  AND op.deleted_at IS NULL;

-- Add the FK constraint NOT VALID: existing rows are not scanned, so no long lock.
-- New inserts and updates are checked immediately.
-- Migration 0487 runs VALIDATE CONSTRAINT.
-- `ADD CONSTRAINT IF NOT EXISTS` is not PostgreSQL syntax at any version, so
-- this statement has never parsed and this migration has never applied. The
-- guard it was reaching for is a catalogue check, which is the idiom used
-- elsewhere in this journal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_people_org_person'
  ) THEN
    ALTER TABLE hr_people
      ADD CONSTRAINT fk_hr_people_org_person
      FOREIGN KEY (org_id, organization_person_id)
      REFERENCES organization_people (organization_id, organization_person_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;
