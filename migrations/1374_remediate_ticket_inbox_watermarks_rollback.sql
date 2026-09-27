SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  ASSERT TRUE, '1374-rollback: nothing to revert — intentionally inert';
END $$;
