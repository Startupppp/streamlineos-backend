-- Wave 2 — standardize org_modules tenant key + add the missing FK.
-- Verified: org_modules has 0 orphan org_id rows. Idempotent + safe (varchar→text widening).
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'org_modules' AND column_name = 'org_id') = 'character varying' THEN
    ALTER TABLE org_modules ALTER COLUMN org_id TYPE text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_org_modules_org') THEN
    ALTER TABLE org_modules
      ADD CONSTRAINT fk_org_modules_org
      FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
  END IF;
END $$;
