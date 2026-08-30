-- Reconcile custom_field_definitions between the chain and the control plane.
--
-- 0352 consolidated six custom-field tables into one. In the control plane it RENAMED columns
-- (name -> key, sort_order -> display_order); on a cold build it now drops and recreates the
-- table instead, because the regenerated 0000 baseline snapshots the pre-consolidation shape.
--
-- The two routes leave the same columns under different constraint names. Postgres keeps a
-- constraint's name when its column is renamed, so the control plane carries
-- custom_field_definitions_name_not_null on a column called "key" -- a name that describes a
-- column which no longer exists. The recreate route auto-names from the real column but takes
-- the Postgres default _fkey for the inline REFERENCES rather than the convention the rest of
-- the schema uses, and loses the (org_id, id) candidate key an earlier migration added.
--
-- Canonical: the constraint is named for the column it actually constrains, and the foreign key
-- follows the <table>_<column>_<reftable>_<refcolumn>_fk convention Drizzle generates.

DO $repair$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
               AND conname = 'custom_field_definitions_name_not_null')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
                       AND conname = 'custom_field_definitions_key_not_null') THEN
    ALTER TABLE "custom_field_definitions"
      RENAME CONSTRAINT "custom_field_definitions_name_not_null" TO "custom_field_definitions_key_not_null";
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
               AND conname = 'custom_field_definitions_sort_order_not_null')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
                       AND conname = 'custom_field_definitions_display_order_not_null') THEN
    ALTER TABLE "custom_field_definitions"
      RENAME CONSTRAINT "custom_field_definitions_sort_order_not_null" TO "custom_field_definitions_display_order_not_null";
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
               AND conname = 'custom_field_definitions_org_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
                       AND conname = 'custom_field_definitions_org_id_organizations_id_fk') THEN
    ALTER TABLE "custom_field_definitions"
      RENAME CONSTRAINT "custom_field_definitions_org_id_fkey" TO "custom_field_definitions_org_id_organizations_id_fk";
  END IF;
END $repair$;
--> statement-breakpoint

DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.custom_field_definitions'::regclass
                   AND conname = 'uniq_custom_field_definitions_org_id') THEN
    ALTER TABLE "custom_field_definitions"
      ADD CONSTRAINT "uniq_custom_field_definitions_org_id" UNIQUE ("org_id", "id");
  END IF;
END $repair$;
