-- Batch 12 / S1 Wave 2 (step 2.2): Link payroll_entities → legal_entities.
--
-- EXPAND ONLY — nullable FK, no NOT NULL yet.
-- Backfill (Wave 2 step 2.3) and NOT NULL promotion (Wave 6) are separate, later steps.
-- Columns legalName / pan / tan on payroll_entities are NOT dropped here;
-- they remain for backward compat until the contract wave (Wave 7).
--
-- Depends on: 0379_legal_entities_create.sql (legal_entities table must exist).

ALTER TABLE payroll_entities
  ADD COLUMN legal_entity_id text
    REFERENCES legal_entities(id) ON DELETE SET NULL;

-- Supports payroll run scoping: "fetch all employments in legal entity Y"
-- Leading org_id matches the composite-index convention.
CREATE INDEX idx_payroll_entities_legal_entity
  ON payroll_entities (org_id, legal_entity_id);
