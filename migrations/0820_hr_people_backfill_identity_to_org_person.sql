-- 0820_hr_people_backfill_identity_to_org_person
-- Ticket: c16-01 — one table owns a person's identity
--
-- 0486 links hr_people to organization_people and 0487 validates the FK, but
-- 0486 phase C only ever carried three columns across: first_name, last_name
-- and work_email.  0488 drops eleven.  The eight in between --- personal_email,
-- phone, date_of_birth, gender, nationality, address, emergency_contact and
-- avatar_url --- have no copy in organization_people or anywhere else, so
-- running 0488 against a database with real rows destroys them.
--
-- That is the failure 0488's own header warns about ("cannot be undone if the
-- copy in migration 0486 turned out to be wrong").  The copy was wrong.  This
-- migration finishes it, and then verifies it finished, so that 0488 can only
-- ever drop columns whose contents already live in organization_people.
--
-- Only NULL targets are written.  organization_people is the canonical record:
-- where it already holds a value, it wins and hr_people's copy is stale by
-- definition.  Where several hr_people rows point at one canonical person the
-- columns are merged rather than taken from a single winning row, so a pair of
-- rows each holding a different field both survive; the live and most recently
-- updated row supplies any column they genuinely disagree on.
--
-- Nothing here is destructive, and it refuses to report success on data it
-- could not place:
--   * a live hr_people row that 0486 never linked has nowhere to put its
--     identity, so the drop would take it with no copy anywhere;
--   * two hr_people rows offering different values for one canonical person's
--     column mean one of them is lost whichever is chosen.
-- Either aborts the migration with a count instead of proceeding.

SET lock_timeout = '5s';

DO $$
DECLARE
  orphaned bigint;
  uncopied bigint;
  ambiguous bigint;
  pick constant text := 'ORDER BY hp.deleted_at NULLS FIRST, hp.updated_at DESC, hp.id DESC';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hr_people' AND column_name = 'first_name'
  ) THEN
    RAISE NOTICE '0820: hr_people identity columns already dropped, nothing to backfill';
    RETURN;
  END IF;

  -- Two rows disagreeing on one column means the merge below has to choose, and
  -- whatever it does not choose is gone once 0488 runs.  Stop instead.
  EXECUTE $sql$
    SELECT count(*) FROM (
      SELECT 1
        FROM hr_people hp
       WHERE hp.organization_person_id IS NOT NULL
       GROUP BY hp.org_id, hp.organization_person_id
      HAVING count(DISTINCT hp.personal_email)    > 1
          OR count(DISTINCT hp.phone)             > 1
          OR count(DISTINCT hp.date_of_birth)     > 1
          OR count(DISTINCT hp.gender)            > 1
          OR count(DISTINCT hp.nationality)       > 1
          OR count(DISTINCT hp.address)           > 1
          OR count(DISTINCT hp.emergency_contact) > 1
          OR count(DISTINCT hp.avatar_url)        > 1
          OR count(DISTINCT hp.work_email)        > 1
    ) conflicting
  $sql$ INTO ambiguous;

  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      '0820: % canonical people have hr_people rows disagreeing on an identity column. Reconcile them before 0488 drops the columns.',
      ambiguous;
  END IF;

  EXECUTE format($sql$
    WITH src AS (
      SELECT hp.org_id,
             hp.organization_person_id,
             (array_agg(hp.work_email        %1$s) FILTER (WHERE hp.work_email        IS NOT NULL))[1] AS work_email,
             (array_agg(hp.personal_email    %1$s) FILTER (WHERE hp.personal_email    IS NOT NULL))[1] AS personal_email,
             (array_agg(hp.phone             %1$s) FILTER (WHERE hp.phone             IS NOT NULL))[1] AS phone,
             (array_agg(hp.date_of_birth     %1$s) FILTER (WHERE hp.date_of_birth     IS NOT NULL))[1] AS date_of_birth,
             (array_agg(hp.gender            %1$s) FILTER (WHERE hp.gender            IS NOT NULL))[1] AS gender,
             (array_agg(hp.nationality       %1$s) FILTER (WHERE hp.nationality       IS NOT NULL))[1] AS nationality,
             (array_agg(hp.address           %1$s) FILTER (WHERE hp.address           IS NOT NULL))[1] AS address,
             (array_agg(hp.emergency_contact %1$s) FILTER (WHERE hp.emergency_contact IS NOT NULL))[1] AS emergency_contact,
             (array_agg(hp.avatar_url        %1$s) FILTER (WHERE hp.avatar_url        IS NOT NULL))[1] AS avatar_url
        FROM hr_people hp
       WHERE hp.organization_person_id IS NOT NULL
       GROUP BY hp.org_id, hp.organization_person_id
    )
    UPDATE organization_people op
       SET work_email        = COALESCE(op.work_email,        src.work_email),
           personal_email    = COALESCE(op.personal_email,    src.personal_email),
           phone             = COALESCE(op.phone,             src.phone),
           date_of_birth     = COALESCE(op.date_of_birth,     src.date_of_birth),
           gender            = COALESCE(op.gender,            src.gender),
           nationality       = COALESCE(op.nationality,       src.nationality),
           address           = COALESCE(op.address,           src.address),
           emergency_contact = COALESCE(op.emergency_contact, src.emergency_contact),
           avatar_url        = COALESCE(op.avatar_url,        src.avatar_url)
      FROM src
     WHERE op.organization_id        = src.org_id
       AND op.organization_person_id = src.organization_person_id
  $sql$, pick);

  EXECUTE $sql$
    SELECT count(*) FROM hr_people hp
     WHERE hp.deleted_at IS NULL
       AND hp.organization_person_id IS NULL
       AND (hp.personal_email IS NOT NULL OR hp.phone IS NOT NULL
         OR hp.date_of_birth IS NOT NULL OR hp.gender IS NOT NULL
         OR hp.nationality IS NOT NULL OR hp.address IS NOT NULL
         OR hp.emergency_contact IS NOT NULL OR hp.avatar_url IS NOT NULL)
  $sql$ INTO orphaned;

  EXECUTE $sql$
    SELECT count(*)
      FROM hr_people hp
      JOIN organization_people op
        ON op.organization_id = hp.org_id
       AND op.organization_person_id = hp.organization_person_id
     WHERE (hp.personal_email    IS NOT NULL AND op.personal_email    IS NULL)
        OR (hp.phone             IS NOT NULL AND op.phone             IS NULL)
        OR (hp.date_of_birth     IS NOT NULL AND op.date_of_birth     IS NULL)
        OR (hp.gender            IS NOT NULL AND op.gender            IS NULL)
        OR (hp.nationality       IS NOT NULL AND op.nationality       IS NULL)
        OR (hp.address           IS NOT NULL AND op.address           IS NULL)
        OR (hp.emergency_contact IS NOT NULL AND op.emergency_contact IS NULL)
        OR (hp.avatar_url        IS NOT NULL AND op.avatar_url        IS NULL)
  $sql$ INTO uncopied;

  IF orphaned > 0 OR uncopied > 0 THEN
    RAISE EXCEPTION
      '0820: identity backfill incomplete (% unlinked live rows, % uncopied values). 0488 would destroy this data; resolve before dropping the columns.',
      orphaned, uncopied;
  END IF;

  RAISE NOTICE '0820: hr_people identity fully mirrored into organization_people';
END $$;
