-- 1067 DOWN — drops the three HR identity and search indexes.
--
-- @reopens-a-defect: (1) the partial unique on hr_employments(org_id, person_id)
-- WHERE is_primary AND deleted_at IS NULL is removed, so two concurrent creates for
-- the same person can again both read zero primaries and both insert a primary row,
-- duplicating that employee in directory counts and keyset pages; (2) the partial unique
-- on hr_people(org_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL is
-- removed, so concurrent onboarding paths can insert duplicate live person rows;
-- (3) idx_users_last_name_trgm is removed, so the ILIKE fallback in employee search
-- reverts to a sequential scan of the global users table on every over-cap search.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_hr_employments_org_person_primary";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_hr_people_org_user_live";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_users_last_name_trgm";
