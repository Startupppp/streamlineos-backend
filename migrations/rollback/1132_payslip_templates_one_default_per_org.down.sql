-- Rollback for migration 1132.
--
-- Dropping the index restores the pre-1132 state exactly: the invariant goes back to being
-- maintained only by `payslip-templates.service.ts`, and the concurrent-first-read seed race
-- it closed is live again. No data is lost or changed — the index constrained rows, it never
-- stored any.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_payslip_templates_org_default";
