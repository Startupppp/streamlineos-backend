SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_huddles' AND column_name = 'started_by'
  ) THEN
    EXECUTE $q$
      UPDATE chat_huddles
      SET started_by_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_huddles.org_id
          AND om.user_id = chat_huddles.started_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE started_by_membership_id IS NULL
        AND started_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_huddle_participants' AND column_name = 'user_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_huddle_participants
      SET membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_huddle_participants.org_id
          AND om.user_id = chat_huddle_participants.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE membership_id IS NULL
    $q$;
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM chat_huddle_participants WHERE membership_id IS NULL;
--> statement-breakpoint

DELETE FROM chat_huddles WHERE started_by_membership_id IS NULL;
--> statement-breakpoint

ALTER TABLE chat_huddles
  DROP CONSTRAINT IF EXISTS fk_chat_huddles_org_starter_membership;
--> statement-breakpoint

ALTER TABLE chat_huddles
  ADD CONSTRAINT fk_chat_huddles_org_starter_membership
    FOREIGN KEY (org_id, started_by_membership_id)
    REFERENCES organization_members (org_id, id)
    ON DELETE CASCADE
    NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_huddles VALIDATE CONSTRAINT fk_chat_huddles_org_starter_membership;
--> statement-breakpoint

ALTER TABLE chat_huddles
  ADD CONSTRAINT chk_huddles_sbmid_notnull
    CHECK (started_by_membership_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_huddles VALIDATE CONSTRAINT chk_huddles_sbmid_notnull;
--> statement-breakpoint

ALTER TABLE chat_huddles
  ALTER COLUMN started_by_membership_id SET NOT NULL;
--> statement-breakpoint

ALTER TABLE chat_huddles
  DROP CONSTRAINT chk_huddles_sbmid_notnull;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants
  ADD CONSTRAINT chk_participants_mid_notnull
    CHECK (membership_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants VALIDATE CONSTRAINT chk_participants_mid_notnull;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants
  ALTER COLUMN membership_id SET NOT NULL;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants
  DROP CONSTRAINT chk_participants_mid_notnull;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_huddle_participant;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participant
  ON chat_huddle_participants (huddle_id, membership_id);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'chat_huddle_participants' AND indexname = 'uniq_huddle_participant'
  ) THEN
    RAISE EXCEPTION '0797: uniq_huddle_participant is missing — onConflictDoUpdate on (huddle_id, membership_id) has no arbiter index';
  END IF;
END $$;
