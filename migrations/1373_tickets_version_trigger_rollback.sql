SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tickets_version_bump'
      AND tgrelid = 'build.tickets'::regclass
  ) THEN
    RAISE EXCEPTION '1373-rollback precondition: trg_tickets_version_bump does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_tickets_version_bump ON build.tickets;
--> statement-breakpoint

DROP FUNCTION IF EXISTS build.bump_ticket_version();
