SET lock_timeout = '5s';
--> statement-breakpoint

-- Rollback is intentionally inert.
-- The forward migration resets timestamp-scale aggregate_version values (> 1e9)
-- to 0 for aggregate_type = 'ticket'. Restoring those values would re-introduce
-- the permanent-skip bug: any row-scale event (version 1..N) would remain
-- permanently blocked by a watermark twelve orders of magnitude larger.
-- Rolling back here would be strictly harmful. Provide a no-op so the
-- check:migration-rollback gate is satisfied while being honest about intent.

DO $$
BEGIN
  ASSERT TRUE, '1374-rollback: nothing to revert — intentionally inert';
END $$;
