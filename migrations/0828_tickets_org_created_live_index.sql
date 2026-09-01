-- Org-scoped ticket lists order by (created_at DESC, id) and filter deleted_at IS NULL,
-- but every existing covering index leads with project_id, so an all-org list fell back
-- to a sequential scan plus a sort. Measured as streamline_app with the tenant GUC on
-- 200,000 tickets: 21,866 buffers without this index, 104 with it.
--
-- org_id leads because the RLS policy adds org_id = app.current_org_id(), which is not
-- leakproof and is therefore evaluated against the heap tuple; an index that does not
-- supply org_id itself is refused outright.
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_org_created_live
  ON build.tickets (org_id, created_at DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'tickets'
      AND indexname = 'idx_tickets_org_created_live'
  ) THEN
    RAISE EXCEPTION '0828: idx_tickets_org_created_live was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND indexname = 'idx_tickets_org_created_live'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ) THEN
    RAISE EXCEPTION '0828: idx_tickets_org_created_live is not the partial (live-rows) form';
  END IF;
END $$;
