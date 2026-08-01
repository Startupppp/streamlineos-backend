SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0379 — drop the orphaned integer users.department_id.
-- Departments became org_units with uuid ids; this column kept its old integer
-- type with no FK, so every filter that still pointed at it coerced a uuid to
-- NaN and silently matched nothing. All readers now use org_department_id.
-- Verified before dropping: no code reference, no dependent FK, no non-null row.

DROP INDEX IF EXISTS "idx_users_department";
--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "department_id";
