SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS communication_backfill_issues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  target TEXT;
  actor RECORD;
  tables TEXT[] := ARRAY[
    'chat_channels:created_by:created_by_membership_id',
    'chat_channel_members:user_id:membership_id',
    'chat_messages:sender_id:sender_membership_id',
    'chat_pinned_messages:pinned_by:pinned_by_membership_id',
    'chat_saved_messages:user_id:membership_id',
    'chat_reply_reminders:recipient_user_id:recipient_membership_id',
    'chat_reply_reminders:sender_user_id:sender_membership_id',
    'chat_huddles:started_by:started_by_membership_id',
    'chat_huddle_participants:user_id:membership_id',
    'chat_channel_invite_links:created_by:created_by_membership_id',
    'chat_org_settings:updated_by:updated_by_membership_id',
    'kb_pages:created_by_id:created_by_membership_id',
    'kb_pages:last_edited_by_id:last_edited_by_membership_id',
    'kb_pages:deleted_by_id:deleted_by_membership_id',
    'kb_pages:owner_user_id:owner_membership_id',
    'kb_pages:verified_by_id:verified_by_membership_id'
  ];
  parts TEXT[];
BEGIN
  FOREACH target IN ARRAY tables LOOP
    parts := string_to_array(target, ':');
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I INTEGER', parts[1], parts[3]);
    EXECUTE format(
      'UPDATE %I row SET %I = member.id FROM organization_members member WHERE row.org_id = member.org_id AND row.%I = member.user_id AND row.%I IS NULL',
      parts[1], parts[3], parts[2], parts[3]
    );
    EXECUTE format(
      'INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details) SELECT row.org_id, %L, row.id::text, %L, jsonb_build_object(''legacyUserId'', row.%I) FROM %I row WHERE row.%I IS NULL AND row.%I IS NOT NULL',
      parts[1], 'unmappable_membership', parts[2], parts[1], parts[3], parts[2]
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id, %I)', 'idx_' || parts[1] || '_' || parts[3], parts[1], parts[3]);
  END LOOP;
END $$;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  IF to_regclass('public.chat_channels') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_channels_org_creator_membership') THEN
      ALTER TABLE chat_channels ADD CONSTRAINT fk_chat_channels_org_creator_membership
        FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
    END IF;
  END IF;
  IF to_regclass('public.chat_messages') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_messages_org_sender_membership') THEN
      ALTER TABLE chat_messages ADD CONSTRAINT fk_chat_messages_org_sender_membership
        FOREIGN KEY (org_id, sender_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
    END IF;
  END IF;
  IF to_regclass('public.kb_pages') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_created_membership') THEN
      ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_created_membership
        FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_owner_membership') THEN
      ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_owner_membership
        FOREIGN KEY (org_id, owner_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL NOT VALID;
    END IF;
  END IF;
END $$;

COMMENT ON TABLE communication_backfill_issues IS 'Durable diagnostics for actor-to-membership contraction; rows are reviewed before legacy columns are removed.';
