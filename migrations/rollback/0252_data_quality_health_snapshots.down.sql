-- Undo 0252.
--
-- The table holds nothing that is not recomputable going forward: every point is
-- an aggregate of the open queue at the moment it was written, and the first
-- capture after a re-apply starts a fresh series. What is genuinely lost is the
-- *history* -- the whole reason the table exists, since severity is mutated by
-- re-detection and the past cannot be reconstructed from `data_quality_findings`
-- afterwards. So this drops a graph, not a record anything else depends on, but
-- the graph does not come back.
--
-- `RESTRICT` rather than `CASCADE`: nothing should be pointing at a snapshot,
-- and if something has grown a foreign key to one since, this must fail loudly
-- rather than silently take that with it.

SET lock_timeout = '5s';

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_data_quality_health_snapshots_series";

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_data_quality_health_snapshots_day";

--> statement-breakpoint
ALTER TABLE IF EXISTS "data_quality_health_snapshots"
  DROP CONSTRAINT IF EXISTS "uniq_data_quality_health_snapshots_org_id";

--> statement-breakpoint
ALTER TABLE IF EXISTS "data_quality_health_snapshots"
  DROP CONSTRAINT IF EXISTS "fk_data_quality_health_snapshots_org";

--> statement-breakpoint
ALTER TABLE IF EXISTS "data_quality_health_snapshots"
  DROP CONSTRAINT IF EXISTS "chk_data_quality_health_snapshots_counts";

--> statement-breakpoint
DROP TABLE IF EXISTS "data_quality_health_snapshots" RESTRICT;
