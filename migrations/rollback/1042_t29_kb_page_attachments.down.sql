-- 1042 DOWN -- drops the KB page attachment ledger.
--
-- @data-loss: dropping the table discards every attachment row written since
-- 1042 applied. The R2 objects those rows point at are NOT removed by this
-- rollback and are not removed by the forward migration either, so rolling back
-- returns the system to its pre-1042 state exactly: the objects still exist and
-- nothing in the database knows about them. There is no way to reconstruct the
-- rows afterwards other than re-listing the bucket prefix.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "kb_page_attachments";
