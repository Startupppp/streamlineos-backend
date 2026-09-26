-- Rollback for 1236_hr_top_level_roles
-- Drops the top-level role table. The onboarding audit rows the backfill read are untouched, so
-- re-applying 1236 reconstructs the backfilled rows; roles recorded since are lost.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."hr_top_level_roles";
