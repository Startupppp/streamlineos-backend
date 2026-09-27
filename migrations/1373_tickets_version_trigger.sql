SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1373 precondition: build.tickets is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION build.bump_ticket_version()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER trg_tickets_version_bump
  BEFORE UPDATE ON build.tickets
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_ticket_version();
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tickets_version_bump'
      AND tgrelid = 'build.tickets'::regclass
  ), '1373 post-check: trg_tickets_version_bump was not created on build.tickets';
END $$;
