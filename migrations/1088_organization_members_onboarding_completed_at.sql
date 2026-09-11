-- Employee onboarding is per organisation — its bank, statutory and leave-balance writes are all
-- org-scoped — but the completion stamp lived only on users.onboarding_completed_at, so a member
-- who finished it in one organisation skipped it in every organisation they joined afterwards, and
-- those organisations never received their details.
--
-- Backfilled from the user stamp so nobody who has already completed onboarding is sent through
-- it again; only memberships created from here on owe a fresh pass.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp;
--> statement-breakpoint
UPDATE "organization_members" m
SET "onboarding_completed_at" = u."onboarding_completed_at"
FROM "users" u
WHERE u."id" = m."user_id"
  AND m."onboarding_completed_at" IS NULL
  AND u."onboarding_completed_at" IS NOT NULL;
