-- 1055 DOWN — returns affiliates to the deployment-global UNIQUE(user_id) that
-- migration 0000 created.
--
-- @reopens-a-defect: the global key is what makes a user an affiliate in exactly
-- one organisation across the whole deployment. Running this puts
-- POST /billing/affiliate/register back on an uncaught SQLSTATE 23505 → 500 for
-- any user who is already an affiliate elsewhere. Revert
-- AffiliateService.register's pre-check to (org_id, user_membership_id) in the same
-- change, or do not run this file.
--
-- THIS FILE CAN FAIL, and that is deliberate. The forward migration is a widening,
-- so going back is a NARROWING: if any user has become an affiliate in two
-- organisations since 1055 ran, UNIQUE(user_id) can no longer be created and the
-- ADD CONSTRAINT below raises 23505. There is no safe automatic answer — deleting
-- one of the two rows destroys a real affiliate relationship and its commission
-- history — so the precondition below names the offending users and stops.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM (SELECT user_id FROM affiliates GROUP BY user_id HAVING count(*) > 1) d;
  IF offending > 0 THEN
    RAISE EXCEPTION
      '1055 DOWN: % user(s) are affiliates in more than one organisation; UNIQUE(user_id) cannot be restored without destroying an affiliate relationship',
      offending
      USING HINT = 'Resolve those users manually, or stay on 1055.';
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "uniq_affiliates_org_user";
--> statement-breakpoint

ALTER TABLE "affiliates"
  ADD CONSTRAINT "affiliates_user_id_unique" UNIQUE ("user_id");
