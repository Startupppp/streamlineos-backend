SET lock_timeout = '5s';

DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM calendar_source_preferences pref
  WHERE NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.id = pref.membership_id
      AND om.org_id = pref.org_id
  );
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'refusing to drop calendar_source_preferences.user_id: % row(s) have orphaned membership_id with no matching org member', orphaned;
  END IF;
END $$;

DROP INDEX IF EXISTS uniq_cal_src_pref_org_user_key;
DROP INDEX IF EXISTS idx_cal_src_pref_org_user;

ALTER TABLE calendar_source_preferences
  DROP CONSTRAINT IF EXISTS calendar_source_preferences_user_id_users_id_fk;

ALTER TABLE calendar_source_preferences
  DROP COLUMN IF EXISTS user_id;
