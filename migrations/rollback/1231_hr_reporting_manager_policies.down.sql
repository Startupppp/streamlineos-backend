-- Rollback for 1231_hr_reporting_manager_policies
-- Drops the policy table with its constraints, index and RLS policy. Organisations fall back to
-- the defaults the service applies when no row exists.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."hr_reporting_manager_policies";
