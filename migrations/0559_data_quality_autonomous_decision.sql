-- The column an autonomous repair writes when it closes a finding.
--
-- `data_quality_findings.autonomous_decision_id` and its partial index are
-- declared in `src/db/schema/crm/data-quality.ts` and no migration ever added
-- them. `0533_autonomy_repairs` created the repair tables and stopped short of
-- the column the repair path writes back through, so on a database built from
-- this journal an auto-repair fails on the write that records what it did.
--
-- The index is the reopen path: a repair batch that has to be undone finds the
-- findings it closed by exactly this predicate, which is why it is partial on
-- `IS NOT NULL` — the open findings are the overwhelming majority and none of
-- them is ever the subject of that read.
--
-- Deliberately no foreign key to `autonomous_decisions`, matching the column
-- beside it: a finding outlives the decision that closed it, and the ledger is
-- an audit record rather than a parent.

-- Fail fast rather than queue behind whatever holds the table.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "data_quality_findings"
  ADD COLUMN IF NOT EXISTS "autonomous_decision_id" TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_autonomous_decision"
  ON "data_quality_findings" ("organization_id", "autonomous_decision_id")
  WHERE "autonomous_decision_id" IS NOT NULL;
