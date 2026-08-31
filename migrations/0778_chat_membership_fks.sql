SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "chat_channels"
  ADD CONSTRAINT "fk_chat_channels_org_created_by_membership"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "fk_chat_messages_org_sender_membership"
  FOREIGN KEY ("org_id", "sender_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE SET NULL ("sender_membership_id")
  NOT VALID;
--> statement-breakpoint

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
  FROM pg_constraint c
  WHERE c.conname IN (
      'fk_chat_channels_org_created_by_membership',
      'fk_chat_messages_org_sender_membership'
    )
    AND c.contype = 'f'
    AND c.confdeltype = 'n'
    AND (c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0778: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE conname IN (
        'fk_chat_channels_org_created_by_membership',
        'fk_chat_messages_org_sender_membership')
        AND contype = 'f') <> 2 THEN
    RAISE EXCEPTION '0778: expected both chat membership foreign keys to exist';
  END IF;
END $$;
