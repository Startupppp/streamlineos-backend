SET lock_timeout = '5s';

ALTER TABLE calendar_source_preferences
  ADD CONSTRAINT chk_cal_src_pref_membership_not_null
  CHECK (membership_id IS NOT NULL) NOT VALID;

ALTER TABLE calendar_source_preferences
  VALIDATE CONSTRAINT chk_cal_src_pref_membership_not_null;

ALTER TABLE calendar_source_preferences
  ALTER COLUMN membership_id SET NOT NULL;

ALTER TABLE calendar_source_preferences
  DROP CONSTRAINT chk_cal_src_pref_membership_not_null;
