-- 1023 DOWN -- drops the five foreign keys and their four supporting indexes, then puts the
-- five columns back to `integer`.
--
-- The reverse cast is only total when every value is numeric, which is exactly the state
-- 1023 started from (0 rows on every measured database, because the write path could not
-- produce one). If a row has been written since -- which is what 1023 makes possible -- its
-- id is a text organisation or user id and `::integer` cannot represent it. This file
-- RAISEs in that case rather than losing the value: the operational undo for a populated
-- table is to remove the rows first, deliberately.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE referrals DROP CONSTRAINT IF EXISTS fk_referrals_referrer_org;
--> statement-breakpoint

ALTER TABLE referrals DROP CONSTRAINT IF EXISTS fk_referrals_referred_org;
--> statement-breakpoint

ALTER TABLE referrals DROP CONSTRAINT IF EXISTS fk_referrals_referrer_user;
--> statement-breakpoint

ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS fk_affiliate_commissions_referred_org;
--> statement-breakpoint

ALTER TABLE app_installations DROP CONSTRAINT IF EXISTS fk_app_installations_installed_by;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_referrals_referred_org;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_referrals_referrer_user;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_affiliate_commissions_referred_org;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_app_installations_installed_by;
--> statement-breakpoint

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM referrals
    WHERE referrer_org_id !~ '^-?[0-9]+$'
       OR referrer_user_id !~ '^-?[0-9]+$'
       OR (referred_org_id IS NOT NULL AND referred_org_id !~ '^-?[0-9]+$');
  IF n > 0 THEN
    RAISE EXCEPTION
      'referrals: % row(s) hold a non-numeric id and cannot be cast back to integer. Remove them first if the revert is intended.', n;
  END IF;

  SELECT count(*) INTO n FROM affiliate_commissions WHERE referred_org_id !~ '^-?[0-9]+$';
  IF n > 0 THEN
    RAISE EXCEPTION
      'affiliate_commissions: % row(s) hold a non-numeric referred_org_id and cannot be cast back to integer.', n;
  END IF;

  SELECT count(*) INTO n FROM app_installations WHERE installed_by !~ '^-?[0-9]+$';
  IF n > 0 THEN
    RAISE EXCEPTION
      'app_installations: % row(s) hold a non-numeric installed_by and cannot be cast back to integer.', n;
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referrer_org_id TYPE integer USING referrer_org_id::integer;
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referred_org_id TYPE integer USING referred_org_id::integer;
--> statement-breakpoint

ALTER TABLE referrals ALTER COLUMN referrer_user_id TYPE integer USING referrer_user_id::integer;
--> statement-breakpoint

ALTER TABLE affiliate_commissions ALTER COLUMN referred_org_id TYPE integer USING referred_org_id::integer;
--> statement-breakpoint

ALTER TABLE app_installations ALTER COLUMN installed_by TYPE integer USING installed_by::integer;
