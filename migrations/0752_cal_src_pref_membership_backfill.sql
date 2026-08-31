SET lock_timeout = '5s';

UPDATE calendar_source_preferences pref
SET membership_id = member.id
FROM organization_members member
WHERE member.org_id = pref.org_id
  AND member.user_id = pref.user_id
  AND pref.membership_id IS NULL;

DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM calendar_source_preferences
  WHERE membership_id IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'calendar_source_preferences backfill incomplete: % row(s) have no resolvable membership', orphaned;
  END IF;
END $$;

ALTER TABLE calendar_source_preferences
  ADD CONSTRAINT fk_cal_src_pref_org_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE CASCADE NOT VALID;

ALTER TABLE calendar_source_preferences
  VALIDATE CONSTRAINT fk_cal_src_pref_org_membership;

CREATE INDEX IF NOT EXISTS idx_cal_src_pref_org_membership
  ON calendar_source_preferences (org_id, membership_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cal_src_pref_org_membership_key
  ON calendar_source_preferences (org_id, membership_id, source_key);
