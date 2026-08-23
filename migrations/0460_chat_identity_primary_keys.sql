-- The twelve chat tables were the last `serial` primary keys in the product; §3 asks for
-- `generatedAlwaysAsIdentity`. Doing it now is deliberate: these tables hold 20 rows
-- between them, so the rewrite is free. After real traffic it would not be.
--
-- GENERATED ALWAYS refuses an explicit id on insert. Verified before writing this that
-- no chat service supplies one - if that ever changes, the insert fails loudly rather
-- than silently drifting, which is the point of ALWAYS over BY DEFAULT.
--
-- Each column keeps its current values; the new identity sequence is restarted above
-- the existing maximum so the next insert cannot collide with a row already there.

SET lock_timeout = '5s';

DO $$
DECLARE
  target text;
  next_value bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'chat_attachments',
    'chat_channel_invite_links',
    'chat_channel_members',
    'chat_channels',
    'chat_huddle_participants',
    'chat_huddles',
    'chat_messages',
    'chat_org_settings',
    'chat_pinned_messages',
    'chat_reply_reminders',
    'chat_saved_messages',
    'chat_user_presence'
  ]
  LOOP
    -- Already converted by a previous run: nothing to do.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target
        AND column_name = 'id' AND is_identity = 'YES'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN id DROP DEFAULT', target);
    EXECUTE format('DROP SEQUENCE IF EXISTS %I', target || '_id_seq');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY', target);

    EXECUTE format('SELECT COALESCE(MAX(id), 0) + 1 FROM %I', target) INTO next_value;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN id RESTART WITH %s',
      target, next_value
    );
  END LOOP;
END $$;
