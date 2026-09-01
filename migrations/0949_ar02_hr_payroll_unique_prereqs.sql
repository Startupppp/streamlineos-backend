-- AR-02: add UNIQUE(org_id, id) to org_units and legal_entities
-- Required before composite FK creation targeting these tables.
-- Actionable FKs in HR/payroll cluster reference org_units (8 FKs) and legal_entities (1 FK).

SET lock_timeout = '5s';
ALTER TABLE org_units
  ADD CONSTRAINT org_units_org_id_id_uniq
  UNIQUE (org_id, id);
SET lock_timeout = DEFAULT;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_org_id_id_uniq
  UNIQUE (org_id, id);
SET lock_timeout = DEFAULT;
