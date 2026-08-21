-- Rollback: pm_schema_gaps
-- Removes all additive changes from 0159_pm_schema_gaps.sql

-- PM-013 rollback: feedbucket_widgets managed_product_id
ALTER TABLE "feedbucket_widgets"
  DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_managed_product";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedbucket_widgets_managed_product";
--> statement-breakpoint

ALTER TABLE "feedbucket_widgets"
  DROP COLUMN IF EXISTS "managed_product_id";
--> statement-breakpoint

-- PM-003 rollback: managed_product_releases table
DROP TABLE IF EXISTS "managed_product_releases";
--> statement-breakpoint

-- PM-002 rollback: RICE columns on roadmap_items
ALTER TABLE "roadmap_items"
  DROP COLUMN IF EXISTS "reach",
  DROP COLUMN IF EXISTS "impact",
  DROP COLUMN IF EXISTS "confidence",
  DROP COLUMN IF EXISTS "effort";
--> statement-breakpoint

-- PM-001 rollback: CRM linkage on feedbucket_submissions
ALTER TABLE "feedbucket_submissions"
  DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_org";
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions"
  DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedbucket_submissions_crm_org";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedbucket_submissions_crm_contact";
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions"
  DROP COLUMN IF EXISTS "crm_contact_id",
  DROP COLUMN IF EXISTS "crm_organization_id",
  DROP COLUMN IF EXISTS "account_value_snapshot";
--> statement-breakpoint

-- PM-001 rollback: CRM linkage on feedback_posts
ALTER TABLE "feedback_posts"
  DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization";
--> statement-breakpoint

ALTER TABLE "feedback_posts"
  DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedback_posts_crm_org";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedback_posts_crm_contact";
--> statement-breakpoint

ALTER TABLE "feedback_posts"
  DROP COLUMN IF EXISTS "crm_contact_id",
  DROP COLUMN IF EXISTS "crm_organization_id",
  DROP COLUMN IF EXISTS "account_value_snapshot";
