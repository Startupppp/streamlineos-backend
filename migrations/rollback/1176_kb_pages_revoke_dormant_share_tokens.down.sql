SET lock_timeout = '5s';
--> statement-breakpoint

-- There is no structural change to undo, and the cleared tokens are not recoverable from
-- this file: they were random 24-byte secrets with no other copy in the database.
--
-- This is intentional and is the point of the migration. Those tokens addressed pages
-- that are not public, so nothing that resolved before the migration stops resolving
-- after it. Restoring them would restore exactly the revoked-link resurrection the
-- forward migration exists to close.
--
-- If a specific share link must come back, re-share the page: setVisibility mints a new
-- token whenever the stored one is NULL. Recovering the ORIGINAL token value is possible
-- only from PITR, and that window is 1 day.

SELECT 1;
