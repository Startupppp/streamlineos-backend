-- Rollback of 1237_app_org_business_date. Restore the application build that reads CURRENT_DATE
-- (before HRM-15 commit "read current lines on the org's business date") before running this.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.org_business_date(text);
