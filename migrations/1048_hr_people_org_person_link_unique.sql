-- 1048: create the hr_people organisation-person link unique that the Drizzle
-- declaration has always named and no journalled migration has ever created.
--
-- `uniqueIndex("uniq_hr_people_org_person_link")` is declared at
-- db/schema/hr/core-people.ts:85. The only SQL that creates it is
-- migrations/pending/hrms-phase1/0000_hrms_profiles_workforce.sql, which is NOT
-- in meta/_journal.json, so it has never run and cannot run: drizzle-kit migrate
-- skips a file the journal does not list and still prints success. Measured on a
-- database bootstrapped to journal head: hr_people carries five indexes
-- (hr_people_pkey, uniq_hr_people_org_id, idx_hr_people_org,
-- idx_hr_people_org_live, idx_hr_people_user) and NOTHING on
-- organization_person_id.
--
-- Two consequences, and the second is the one that hides:
--
--  1. Nothing stops two hr_people rows pointing at the same directory person in
--     the same organisation. HrPeopleService, HrImportCommitService and
--     RecruitmentHandoffService all insert against that link.
--
--  2. Five call sites already branch on `code === "23505" && constraint ===
--     "uniq_hr_people_org_person_link"` -- hr-people.service.ts:172,
--     recruitment-handoff.service.ts:141/164/179 and
--     hr-import-commit.service.ts:142. Every one of them is dead code today: the
--     constraint they name does not exist, so Postgres never raises 23505 with
--     that name and the branch is unreachable. Code that LOOKS like it handles a
--     duplicate handles nothing.
--
-- The predicate matches the declaration exactly (`WHERE organization_person_id
-- IS NOT NULL`), so an unlinked hr_people row is unconstrained and the many rows
-- that carry NULL there do not collide.
--
-- Existing duplicates: the migration REFUSES rather than de-duplicates. A DELETE
-- here would discard a person record that hr_employments, hr_probation_reviews
-- and the whole HR read surface reference through (org_id, id); choosing a
-- survivor is a data decision a migration must not make silently. Measured on
-- the seeded database (scratch_perf_seed, 6,171 hr_people rows): 0 rows carry a
-- non-null organization_person_id at all, so 0 duplicates and the index builds
-- trivially there. If a real database has duplicates the DO block below names
-- the offending (org_id, organization_person_id) pairs and aborts, which is a
-- far better failure than a bare 23505 from CREATE UNIQUE INDEX.
--
-- CREATE INDEX rather than CONCURRENTLY: drizzle-kit migrate wraps the file in a
-- transaction (check-migration-discipline rule 7). lock_timeout bounds the wait.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  duplicate_count integer;
  sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s) x%s', d.org_id, d.organization_person_id, d.n), '; '), '')
    INTO duplicate_count, sample
    FROM (
      SELECT org_id, organization_person_id, count(*) AS n
        FROM hr_people
       WHERE organization_person_id IS NOT NULL
       GROUP BY org_id, organization_person_id
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'hr_people has % duplicated (org_id, organization_person_id) pair(s); uniq_hr_people_org_person_link cannot be created until they are resolved. First pairs: %',
      duplicate_count, sample
      USING HINT = 'Decide which hr_people row survives per pair and repoint hr_employments / hr_probation_reviews at it before re-running this migration. Do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_people_org_person_link"
  ON "hr_people" ("org_id", "organization_person_id")
  WHERE "organization_person_id" IS NOT NULL;
