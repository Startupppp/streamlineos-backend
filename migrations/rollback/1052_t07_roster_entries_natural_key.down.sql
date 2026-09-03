-- 1052 DOWN -- drops the three catalog objects 1052 installed on roster_entries.
--             It does NOT undo the orphan repair; see @data-loss below.
--
-- @data-loss: the rows whose user_membership_id the forward migration set to NULL are
-- NOT restored. Each named a membership that had already been deleted, so there is
-- nothing to point back at and nothing that records which id each row held -- user_id
-- survives and still names the person, but a deleted organization_members row cannot be
-- looked up from it. This file reverses the objects only, which is why 1052 carries an
-- @data-loss declaration of its own rather than relying on this file to be a full
-- inverse.
--
-- @reopens-a-defect: this is not a neutral reversal, and it is the loudest one in this
-- wave. Dropping uniq_roster_entries_org_roster_membership_date removes the arbiter that
-- RostersService.upsertRosterEntry (src/modules/hr/time/rosters.service.ts:41) infers
-- from, so its ON CONFLICT (org_id, roster_id, user_membership_id, date) DO UPDATE goes
-- back to failing at PLAN time with 42P10 -- on every call, for every tenant, which is
-- the state the endpoint shipped in and 1052 ended. The service's ON CONFLICT target was
-- widened to org_id-leading in the same commit as 1052; narrow that target back in the
-- same change as this file, and revert the uniqueIndex, index and foreignKey
-- declarations at src/db/schema/hr/rosters.ts:36-38, or the declaration and the catalog
-- disagree again in the direction 1052 was written to repair.
--
-- Dropped in reverse install order: the foreign key first, because
-- idx_roster_entries_org_user_membership_date is its referencing-side index and every
-- parent delete probes it, then the two indexes. IF EXISTS throughout so the file is
-- idempotent. No row is read or written, so neither the unique index nor the foreign key
-- can fail on data on the way out.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "roster_entries"
  DROP CONSTRAINT IF EXISTS "fk_roster_entries_user_actor";
--> statement-breakpoint

DROP INDEX IF EXISTS public."idx_roster_entries_org_user_membership_date";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_roster_entries_org_roster_membership_date";
