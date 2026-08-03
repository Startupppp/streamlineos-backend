-- Rollback for 0373 — restore the legacy `numeric` money columns and repopulate
-- them from the integer minor-unit columns that replaced them.
--
-- Genuinely reversible: minor units are the source of truth after 0370, so the
-- restored `numeric` values are exact (integer cents / 100, no float involved).
-- Rounding cannot lose precision because minor units carry more of it than the
-- numeric(x,2) columns ever did.

SET statement_timeout = 0;

--> statement-breakpoint
ALTER TABLE "projects"        ADD COLUMN IF NOT EXISTS "budget"      numeric(15,2);
--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "hourly_rate" numeric(10,2);

--> statement-breakpoint
UPDATE "projects"
SET "budget" = ROUND("budget_minor"::numeric / 100, 2)
WHERE "budget_minor" IS NOT NULL AND "budget" IS NULL;

--> statement-breakpoint
UPDATE "project_members"
SET "hourly_rate" = ROUND("hourly_rate_minor"::numeric / 100, 2)
WHERE "hourly_rate_minor" IS NOT NULL AND "hourly_rate" IS NULL;

--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "hourly_rate" SET DEFAULT '0';
--> statement-breakpoint
UPDATE "project_members" SET "hourly_rate" = 0 WHERE "hourly_rate" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "hourly_rate" SET NOT NULL;
