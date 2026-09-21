-- Rollback for migration 1120.
--
-- DATA LOSS: the three columns added by the forward migration are dropped here.
-- All columns were added nullable with no DEFAULT and no backfill, so their
-- values came entirely from application writes after migration. Any
-- default_project_id, default_assignee_membership_id, or assignee_rules values
-- recorded by the app are unrecoverable after this rollback.
--
-- Reverse order: drop the index first (it covers default_project_id), then the
-- two foreign key constraints, then the columns themselves.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_feedbucket_widgets_default_project";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_default_assignee";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_default_project";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" DROP COLUMN IF EXISTS "assignee_rules";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" DROP COLUMN IF EXISTS "default_assignee_membership_id";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" DROP COLUMN IF EXISTS "default_project_id";
