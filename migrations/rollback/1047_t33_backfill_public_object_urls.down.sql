-- 1047 DOWN -- deliberately does nothing, and this file exists to say why.
--
-- @data-loss: 1047 rewrote stored permanent public object-storage URLs down to
-- the object keys they pointed at. The information it removed is the PUBLIC BASE
-- ("https://pub-<32 hex>.r2.dev"), which is a deployment constant, not per-row
-- data -- so a reversal is arithmetically possible. It is refused anyway.
--
-- REVERSING THIS REOPENS THE EXPOSURE IT CLOSED. Re-minting
-- "<public base>/<key>" would put a permanent, unauthenticated, non-expiring
-- address to a tenant-private object back into tenant tables and back into every
-- response, email body and export that reads those columns -- which is the
-- original defect of ticket 33, restored by a script whose name says "rollback".
-- That is not a schema reversal; it is a re-introduction of a data exposure, and
-- a down-file is the wrong place to hide one.
--
-- It also could not be done correctly. 1047 cannot distinguish a value it
-- rewrote from a value that was ALREADY an object key when it ran -- and the
-- four call sites named in the forward header have been storing bare keys since
-- ticket 33 landed, so most keys in these columns were never URLs at all.
-- Re-minting every key-shaped value would manufacture public URLs for rows that
-- never had one, which is strictly worse than the state 1047 replaced.
--
-- WHAT TO DO INSTEAD, if 1047 is believed to have damaged a column: restore that
-- column from a point-in-time backup. The rewrite is idempotent and re-runnable,
-- so re-applying the forward migration after a restore is safe.
--
-- Nothing below this line changes the database. The statement is a no-op that
-- exists so this file is valid SQL and so `db:migrate` semantics are unchanged
-- if it is ever executed by mistake.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  RAISE WARNING '1047 DOWN is intentionally a no-op: reversing the public-object-URL backfill would re-mint permanent public URLs for tenant-private objects. See the header of this file. Restore from a backup instead.';
END
$$;
