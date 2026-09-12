-- Re-adds the duplicate (org_id, id) key 0622a retired. Foreign keys stay bound to uniq_cfd_org_id:
-- which of two identical keys enforces them changes nothing a query can observe.
DO $twin$ BEGIN
  IF to_regclass('public.custom_field_definitions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.custom_field_definitions'::regclass
                        AND conname = 'uniq_custom_field_definitions_org_id') THEN
    ALTER TABLE custom_field_definitions
      ADD CONSTRAINT uniq_custom_field_definitions_org_id UNIQUE (org_id, id);
  END IF;
END $twin$;
