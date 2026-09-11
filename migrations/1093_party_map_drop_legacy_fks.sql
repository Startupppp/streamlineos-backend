-- 0913 — drop the legacy-table FKs the map cannot satisfy
-- =============================================================================
-- Ticket 08 and migration 0277 moved legacy id minting onto the map tables and
-- stopped writing the legacy row entirely. `lead_party_map.lead_id`,
-- `client_party_map.client_id` and `contact_party_map.contact_id` each default
-- from the sequence the legacy table used to own, detached with `OWNED BY NONE`
-- so dropping that table cannot take it; `mintLegacyId` inserts the MAP row and
-- lets the database hand back the number. `createMirroredLead`,
-- `createMirroredClient` and `createMirroredContact` then assemble the legacy
-- SHAPE in memory — `legacyLeadRow`, `legacyClientRow`, `legacyContactRow` —
-- from the Party that is now the only copy. None of them inserts into `leads`,
-- `clients` or `contacts`. That is the point of the phase: one record, one
-- source of truth, an identifier that does not change.
--
-- 0620 then added
--
--   fk_lead_party_map_legacy    (organization_id, lead_id)    → leads(org_id, id)
--   fk_client_party_map_legacy  (organization_id, client_id)  → clients(org_id, id)
--   fk_contact_party_map_legacy (organization_id, contact_id) → contacts(org_id, id)
--
-- which require a legacy row that the write path deliberately does not create.
-- 0620 is machine-generated — "objects the migration chain creates that the
-- running control plane never received", emitted from pg_catalog by
-- generate-chain-repair.mjs — so these were replayed from an older catalogue
-- rather than chosen. `crm_org_party_map` mints ids exactly the same way and
-- received no such FK; that asymmetry is the tell, and it is the correct shape.
--
-- The effect is that every mirrored create fails with "insert or update on table
-- lead_party_map violates foreign key constraint fk_lead_party_map_legacy" —
-- CRM lead, client and contact creation, through the writer the whole dual-write
-- window runs on.
--
-- Deferring instead of dropping is not a fix and was tried first: the referent
-- is never written, so `DEFERRABLE INITIALLY DEFERRED` merely moves the same
-- violation from the statement to the COMMIT. It makes a rolled-back test pass
-- and leaves production exactly as broken. Measured, not reasoned about.
--
-- Tenant isolation is unaffected: `fk_*_party_map_org` still ties
-- `organization_id` to `organizations`, and `fk_*_party_map_party` still ties
-- `(organization_id, party_id)` to `business_parties`, which is where the record
-- actually lives.
-- =============================================================================

SET lock_timeout = '5s';

ALTER TABLE "lead_party_map"
  DROP CONSTRAINT IF EXISTS "fk_lead_party_map_legacy";
--> statement-breakpoint

ALTER TABLE "client_party_map"
  DROP CONSTRAINT IF EXISTS "fk_client_party_map_legacy";
--> statement-breakpoint

ALTER TABLE "contact_party_map"
  DROP CONSTRAINT IF EXISTS "fk_contact_party_map_legacy";
