SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'app' AND p.proname = 'search_mention_user_ids'
  ) THEN
    RAISE EXCEPTION '1377-rollback precondition: app.search_mention_user_ids does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP FUNCTION app.search_mention_user_ids(text[]);
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'app' AND p.proname = 'search_mention_user_ids'
  ), '1377-rollback post-check: app.search_mention_user_ids still exists after drop';
END $$;
