CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Pre-flight: run this query first and fix any rows it returns before applying
-- the constraint below. The EXCLUDE will fail if overlapping PLANNED/ACTIVE rows
-- already exist for the same worker in the same org.
--
-- SELECT a.worker_engagement_id,
--        a.worker_id,
--        a.organization_id,
--        a.starts_on,
--        a.ends_on,
--        a.status,
--        b.worker_engagement_id AS conflict_id,
--        b.starts_on            AS conflict_starts,
--        b.ends_on              AS conflict_ends,
--        b.status               AS conflict_status
-- FROM   worker_engagements a
-- JOIN   worker_engagements b
--   ON   a.organization_id  = b.organization_id
--  AND   a.worker_id        = b.worker_id
--  AND   a.worker_engagement_id <> b.worker_engagement_id
--  AND   daterange(a.starts_on, COALESCE(a.ends_on, 'infinity'::date), '[)')
--     && daterange(b.starts_on, COALESCE(b.ends_on, 'infinity'::date), '[)')
-- WHERE  a.status NOT IN ('COMPLETED', 'TERMINATED', 'CANCELLED')
--   AND  b.status NOT IN ('COMPLETED', 'TERMINATED', 'CANCELLED')
-- ORDER  BY a.organization_id, a.worker_id, a.starts_on;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'excl_worker_engagements_overlap'
  ) THEN
    ALTER TABLE worker_engagements
      ADD CONSTRAINT excl_worker_engagements_overlap
      EXCLUDE USING gist (
        organization_id WITH =,
        worker_id       WITH =,
        daterange(
          starts_on,
          COALESCE(ends_on, 'infinity'::date),
          '[)'
        ) WITH &&
      ) WHERE (status NOT IN ('COMPLETED', 'TERMINATED', 'CANCELLED'));
  END IF;
END;
$$;
