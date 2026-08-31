SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_survey_ver_org_creator_mbr' AND contype = 'f' AND convalidated
  ) THEN
    RAISE EXCEPTION '0816: fk_survey_ver_org_creator_mbr is not yet validated — run 0815 first';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE survey_versions DROP CONSTRAINT IF EXISTS survey_versions_created_by_fkey;
--> statement-breakpoint

ALTER TABLE survey_versions DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_versions' AND column_name = 'created_by'
  ) THEN
    RAISE EXCEPTION '0816: legacy created_by column still present in survey_versions — drop did not complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_versions' AND column_name = 'created_by_membership_id'
  ) THEN
    RAISE EXCEPTION '0816: created_by_membership_id missing from survey_versions — 0815 companion was not applied';
  END IF;
END $$;
