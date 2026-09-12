-- 1105 — a counter for the export's outbox version
-- =============================================================================
-- `timesheet_exports` emits `timesheets.payroll_export.created` at version 1
-- and then one `timesheets.payroll_export.acked` per acknowledgement, and the
-- outbox is unique on (org, aggregate_type, aggregate_id, aggregate_version).
-- The acknowledgement used the wall-clock millisecond as its version: unique
-- only while two acknowledgements never share a millisecond, and ordered only
-- within one node's clock. 0659b gave `timesheet_periods` a real counter for
-- the same reason; this is the export's.
--
-- DEFAULT 1 because the creation event has already spent version 1 for every
-- existing row; the first acknowledgement after this migration claims 2.
-- Earlier acknowledgements keep their millisecond versions, which are twelve
-- orders of magnitude above any counter and cannot collide with it.
--
-- Adding a NOT NULL column with a constant default is a catalog-only change
-- on this PostgreSQL major; no rewrite, no backfill.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "event_seq" integer NOT NULL DEFAULT 1;
