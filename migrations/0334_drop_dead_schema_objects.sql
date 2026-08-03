SET statement_timeout = 0;
-- 0334 — drop dead schema objects
-- =============================================================================
-- Removes the 12 tables and 4 columns that carry no data and have zero runtime
-- references. Each was verified twice before removal: measured at 0 rows on the
-- live database, and grepped across all of backend/src (Drizzle symbol AND raw
-- SQL table name) plus backend/scripts for callers. The matching Drizzle schema
-- definitions were deleted in the same change, so this migration keeps the
-- database in step with src/db/schema.
--
-- Deliberately NOT dropped:
--   * journal_lines.{client_id,vendor_id,project_id,department_id,employee_id,
--     tax_code_id} — an earlier audit called these dead placeholders, but they
--     are read and written by accounting/finance-posting.service.ts,
--     accounting-gl/general-ledger.service.ts and
--     finance-reports/analytics-reports.service.ts. They stay.
--   * workflow_trigger_type / workflow_node_type enums — still used by the
--     surviving workflow_execution_steps table.
--   * payrolls — write-dead but still read by AI and HR analytics.
-- =============================================================================

DROP TABLE IF EXISTS "workspace_search_chunks" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "workflow_actions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "workflow_triggers" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "party_addresses" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "crm_party_accounts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "crm_views" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "hr_mentorships" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "one_on_one_action_items" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_party_vendor_profiles" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "role_permissions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "target_history" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "targets" CASCADE;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "login_attempts";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "locked_until";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "google_refresh_token";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "google_email";
