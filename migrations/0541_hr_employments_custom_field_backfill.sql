-- 0541 — HR: Backfill custom_field_values JSONB from the legacy sidecar table
--
-- For each employment that has sidecar rows with non-null values, this migration
-- aggregates those values into a single JSONB document keyed by the definition's
-- `key` string and writes the document into the new column added in 0540.
--
-- Rows in the sidecar where value IS NULL are intentionally excluded: a null
-- sidecar value means "explicitly cleared" and we represent that state by the
-- key being absent from the JSONB document (the service treats absent vs null
-- differently and so does the @> containment operator).
--
-- The DO block at the end aborts the migration if any non-null sidecar value did
-- not land VERBATIM under its key in the corresponding JSONB document. It checks
-- value equality, not merely key presence: two definitions in one org can share a
-- `key` across different entity_types (the registry's unique index is on
-- (org_id, entity_type, project_id, key), not on key alone), and jsonb_object_agg
-- resolves such a collision last-one-wins. A presence-only guard would pass while
-- silently discarding a value, which is exactly what this migration must not do.
--
-- Operator note: this UPDATE acquires row-level locks on hr_employments rows.
-- On large tables it will run for minutes; statement_timeout = 0 is required.

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
UPDATE "hr_employments" e
SET "custom_field_values" = sub.doc
FROM (
  SELECT
    v.employment_id,
    jsonb_object_agg(d.key, v.value) AS doc
  FROM "hr_employment_custom_field_values" v
  JOIN "custom_field_definitions" d
    ON d.id = v.field_definition_id
    AND d.org_id = v.org_id
  WHERE v.value IS NOT NULL
  GROUP BY v.employment_id
) sub
WHERE e.id = sub.employment_id;

--> statement-breakpoint
DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT count(*) INTO missing_count
  FROM "hr_employment_custom_field_values" v
  JOIN "custom_field_definitions" d
    ON d.id = v.field_definition_id
    AND d.org_id = v.org_id
  JOIN "hr_employments" e ON e.id = v.employment_id
  WHERE v.value IS NOT NULL
    AND (
      NOT (e.custom_field_values ? d.key)
      OR e.custom_field_values -> d.key IS DISTINCT FROM v.value
    );

  IF missing_count > 0 THEN
    RAISE EXCEPTION
      'Custom-field back-fill incomplete: % sidecar row(s) with a non-null value are missing from hr_employments.custom_field_values, or landed under a key whose value differs (a duplicate key across entity_types). Re-check the UPDATE in this migration before re-attempting.',
      missing_count;
  END IF;
END $$;
