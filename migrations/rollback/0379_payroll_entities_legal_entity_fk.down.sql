-- Rollback for 0379_payroll_entities_legal_entity_fk.sql

DROP INDEX IF EXISTS idx_payroll_entities_legal_entity;

ALTER TABLE payroll_entities
  DROP COLUMN IF EXISTS legal_entity_id;
