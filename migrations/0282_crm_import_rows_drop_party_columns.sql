-- Custom SQL migration file, put your code below! --

-- The half of 0281 that removes rather than adds.
--
-- `created_party_id` and `matched_party_id` were the outcome columns while the
-- importer could only write parties. 0281 added `created_record_id` and
-- `matched_record_id`, backfilled both from these, and re-pointed
-- `chk_crm_import_rows_outcome` at the new pair. Nothing in `src/` reads the
-- old names any more.
--
-- Separate from 0281 on purpose, and the ordering constraint is real: this must
-- not be applied until the code that stopped reading these columns is live.
-- Applied against a deployment still running the previous build, every commit
-- would fail on a column that is no longer there. Same shape as 0480/0481/0482
-- and 0486/0487/0488 -- add, backfill, then drop as its own step.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP COLUMN IF EXISTS "created_party_id";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP COLUMN IF EXISTS "matched_party_id";

--> statement-breakpoint
ANALYZE "crm_import_rows";
