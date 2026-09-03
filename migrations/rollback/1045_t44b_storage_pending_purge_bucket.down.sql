-- 1045 DOWN -- removes storage_pending_purge.bucket and its CHECK.
--
-- @data-loss: the recorded bucket roles are destroyed and cannot be
-- reconstructed. The row outlives the table its key came from, so nothing left
-- in the database can say which bucket the object is in. After this runs, every
-- pending row is NULL-bucket again, which the storage sweep treats as
-- unresolvable for 'org-purge' -- so rolling back does not restore the previous
-- behaviour, it strands the rows. That is what rolling this back MEANS, and it
-- is recorded here rather than left implicit.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge
  DROP CONSTRAINT IF EXISTS "storage_pending_purge_bucket_check";
--> statement-breakpoint

ALTER TABLE public.storage_pending_purge DROP COLUMN IF EXISTS "bucket";
