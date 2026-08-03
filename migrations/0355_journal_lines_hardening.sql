SET statement_timeout = 0;
-- 0355 — journal_lines tenant isolation + dimension indexes
-- =============================================================================
-- Q-01 (tenant-isolation hole):
--   journal_lines.org_id was nullable.  Every write path (finance-posting.service,
--   recurring-journals.service) populates it, but the schema allowed NULL which
--   defeats the composite tenant FK pattern and means a forgotten assignment
--   silently produces an orphan row.  Fix: backfill any historic NULLs from the
--   parent journal_entries.org_id, then flip the column NOT NULL, then add a
--   composite FK (org_id, entry_id) → journal_entries(org_id, id) using the
--   existing candidate key uniq_journal_entries_org_id.
--
-- Q-02 (missing indexes):
--   Six dimension columns on journal_lines — client_id, vendor_id, project_id,
--   department_id, employee_id, tax_code_id — have no indexes despite being
--   filter targets in general-ledger.service (clientId/vendorId/projectId/
--   departmentId), finance-posting.service (all six, write + read), and
--   analytics-reports.service (projectId, departmentId).  All six confirmed live
--   (also documented explicitly in the 0334 migration header).  Composite indexes
--   lead with org_id per §19.
--
--   Also adds (org_id, status, entry_date) on journal_entries: the hot GL query
--   filters all three but previously had only separate (org_id, entry_date) and
--   (org_id, status) indexes, forcing Postgres to scan the full date range then
--   recheck status in a bitmap-and.
-- =============================================================================

UPDATE "journal_lines" jl
SET    "org_id" = je."org_id"
FROM   "journal_entries" je
WHERE  jl."entry_id" = je."id"
  AND  jl."org_id"   IS NULL;
--> statement-breakpoint
ALTER TABLE "journal_lines" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "fk_jl_org_entry"
  FOREIGN KEY ("org_id", "entry_id")
  REFERENCES "journal_entries" ("org_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_client"      ON "journal_lines" ("org_id", "client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_vendor"      ON "journal_lines" ("org_id", "vendor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_project"     ON "journal_lines" ("org_id", "project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_department"  ON "journal_lines" ("org_id", "department_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_employee"    ON "journal_lines" ("org_id", "employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_org_tax_code"    ON "journal_lines" ("org_id", "tax_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_je_org_status_date" ON "journal_entries" ("org_id", "status", "entry_date");
