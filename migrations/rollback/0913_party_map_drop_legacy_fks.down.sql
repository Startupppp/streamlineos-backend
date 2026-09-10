-- Reverses 0913. Re-adds the three legacy-table foreign keys on the party maps.
--
-- ⚠ READ THIS BEFORE RUNNING IT. Applying this rollback RESTORES A KNOWN
-- PRODUCTION BREAKAGE. These constraints require a row in `leads`, `clients` or
-- `contacts` that the write path deliberately no longer creates — since ticket
-- 08 and migration 0277 the map table mints the id and the legacy shape is
-- assembled in memory from the Party. With these back in place every mirrored
-- create fails with "insert or update on table lead_party_map violates foreign
-- key constraint fk_lead_party_map_legacy", which is CRM lead, client and
-- contact creation through the writer the whole dual-write window runs on.
--
-- It exists anyway, and is not declared @irreversible, because 0913 destroys no
-- data and the prior schema state is exactly reproducible. A rollback restores
-- the state before the migration; it does not promise that state was good. The
-- reason 0913 exists is that it was not.
--
-- IDEMPOTENT, and that is load-bearing rather than tidy. Run against a database
-- where 0913 has not been applied, a bare ADD CONSTRAINT raises 42710
-- "constraint already exists" — measured, not guessed — and the rollback dies on
-- its first statement. The chain is currently in exactly that state on the
-- shared branch. Each constraint is therefore added only when absent, matching
-- how 0620 installed them in the first place.
--
-- NOT VALID ON ALL THREE, which is a real difference from how they were first
-- installed and not a style choice. 0620 added the lead and client constraints
-- WITHOUT `NOT VALID` (only the contact one had it), and that was installable
-- then only because no violating row existed yet. Rows written since 0913 have
-- map entries with no legacy row, so a validating ADD CONSTRAINT would now fail
-- against existing data and this rollback could not run at all. `NOT VALID`
-- checks new writes only — which is precisely the prior behaviour being
-- restored. Do not add a VALIDATE step: it would fail, and passing it would mean
-- the legacy rows are back and 0913 was never needed.
--
-- ACCESS EXCLUSIVE on both tables per side, hence the lock_timeout: this fails
-- fast rather than queueing behind a long read and blocking every write to
-- leads, clients and contacts (backend CLAUDE.md §3).
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_party_map_legacy'
                 AND conrelid = 'public.lead_party_map'::regclass) THEN
    ALTER TABLE "lead_party_map"
      ADD CONSTRAINT "fk_lead_party_map_legacy"
      FOREIGN KEY (organization_id, lead_id) REFERENCES leads(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $rollback$;
--> statement-breakpoint
DO $rollback$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_client_party_map_legacy'
                 AND conrelid = 'public.client_party_map'::regclass) THEN
    ALTER TABLE "client_party_map"
      ADD CONSTRAINT "fk_client_party_map_legacy"
      FOREIGN KEY (organization_id, client_id) REFERENCES clients(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $rollback$;
--> statement-breakpoint
DO $rollback$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contact_party_map_legacy'
                 AND conrelid = 'public.contact_party_map'::regclass) THEN
    ALTER TABLE "contact_party_map"
      ADD CONSTRAINT "fk_contact_party_map_legacy"
      FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $rollback$;
