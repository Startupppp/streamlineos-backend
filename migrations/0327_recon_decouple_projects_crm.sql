-- wave-6-t6.5-decouple-projects-crm.sql
-- Decouple Projects from CRM schema (ADR): tickets.customer_id no longer hard-FKs
-- into crm_organizations. The Drizzle import + relation were removed; customer_id
-- becomes a soft reference resolved at the service layer. Idempotent.
DO $$
DECLARE cn text;
BEGIN
  SELECT con.conname INTO cn FROM pg_constraint con
    JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1]
    WHERE child.relname='tickets' AND parent.relname='crm_organizations'
      AND con.contype='f' AND a.attname='customer_id' LIMIT 1;
  IF cn IS NOT NULL THEN EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I', cn); END IF;
END $$;
