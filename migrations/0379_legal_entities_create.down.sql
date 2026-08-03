-- Rollback for 0379_legal_entities_create.sql
-- Drops the legal_entities table and all dependent objects (indexes, constraints,
-- and any FKs that other tables reference — handled by CASCADE).
--
-- CAUTION: Any rows in payroll_entities.legal_entity_id or hr_employments.legal_entity_id
-- that reference legal_entities will be set to NULL on CASCADE (SET NULL).
-- Ensure the FK columns added by later migrations are already rolled back first,
-- or that no dependent data exists.

DROP TABLE IF EXISTS legal_entities CASCADE;
