-- 1045: storage_pending_purge learns WHICH BUCKET its object is in.
--
-- The row names an object and, until now, not the bucket holding it. That was
-- survivable only while every producer wrote into one bucket. Two do not:
-- KbSourcesService and KbMediaService upload with R2_KB_BUCKET_NAME as the
-- bucket override, so kb_sources.file_key, kb_sources.file_url (which holds the
-- object KEY, not a URL) and kb_page_attachments.file_key all name objects in
-- the KB bucket.
--
-- The organization purge registers a row for EVERY file-key column in the
-- schema under the single purpose 'org-purge', so a purpose -> bucket map --
-- the resolution the storage sweep uses -- provably cannot resolve these: one
-- purpose spans both buckets. Without this column the purge deletes a KB object
-- from the DEFAULT bucket (an S3-compatible delete of an absent key answers
-- SUCCESS), then confirms it ABSENT from the DEFAULT bucket (it was never
-- there), and reports "deleted and verified absent" while the object survives.
-- The verification step is what makes it convincing. That is a data-retention
-- failure, not an orphan.
--
-- NULLABLE, deliberately. Existing rows legitimately have no bucket recorded
-- and no backfill can know the answer: the row survives its object's table, so
-- the column it came from is gone by the time anyone asks. A NOT NULL with a
-- DEFAULT 'default' would be a backfill that INVENTS the answer, and it would
-- invent it wrongly for exactly the KB rows this column exists to fix. NULL
-- means "no producer recorded one", and the consumer refuses to delete on it
-- rather than guessing -- see cron-storage-sweep.service.ts.
--
-- The CHECK is what keeps NULL the only unknown: a value outside the two roles
-- would be a third unknown wearing the shape of an answer.
--
-- No rewrite and no table scan: ADD COLUMN of a nullable column with no
-- DEFAULT is catalog-only in Postgres 11+, and the CHECK is added NOT VALID and
-- validated separately so the ACCESS EXCLUSIVE lock is not held across a scan.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge ADD COLUMN IF NOT EXISTS "bucket" text;
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge
  DROP CONSTRAINT IF EXISTS "storage_pending_purge_bucket_check";
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge
  ADD CONSTRAINT "storage_pending_purge_bucket_check"
  CHECK ("bucket" IS NULL OR "bucket" IN ('default', 'kb')) NOT VALID;
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge
  VALIDATE CONSTRAINT "storage_pending_purge_bucket_check";
--> statement-breakpoint

-- ADD COLUMN IF NOT EXISTS is silent about a pre-existing column of the wrong
-- type, and a CHECK left NOT VALID looks exactly like a validated one to
-- anything that only asks whether the constraint exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_attribute a
    JOIN   pg_class c ON c.oid = a.attrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_type t ON t.oid = a.atttypid
    WHERE  n.nspname = 'public'
      AND  c.relname = 'storage_pending_purge'
      AND  a.attname = 'bucket'
      AND  NOT a.attisdropped
      AND  t.typname = 'text'
      AND  a.attnotnull = false
  ) THEN
    RAISE EXCEPTION
      '1045: storage_pending_purge.bucket is missing, not text, or NOT NULL -- ADD COLUMN IF NOT EXISTS is silent about a pre-existing column of the wrong shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint k
    JOIN   pg_class c ON c.oid = k.conrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
      AND  c.relname = 'storage_pending_purge'
      AND  k.conname = 'storage_pending_purge_bucket_check'
      AND  k.contype = 'c'
      AND  k.convalidated
  ) THEN
    RAISE EXCEPTION
      '1045: storage_pending_purge_bucket_check is missing or still NOT VALID -- an unvalidated CHECK does not hold for the rows already in the table';
  END IF;
END
$$;
