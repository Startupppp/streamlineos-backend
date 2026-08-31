-- 0822_mail_directory_actor_legacy_drop
-- Drop the two legacy users.id actor columns from mail and directory now that
-- companions exist and are validated (both added + validated in migration 0815).
--
-- Columns dropped:
--   mail_message_metadata   user_id
--   worker_engagements      created_by

SET lock_timeout = '5s';
--> statement-breakpoint

-- Pre-flight: companion FKs must be validated
DO $$
DECLARE
  unvalidated text;
BEGIN
  SELECT string_agg(conname, ', ') INTO unvalidated
  FROM pg_constraint
  WHERE conname IN (
    'fk_mail_meta_org_user_mbr',
    'fk_worker_engagements_created_actor'
  )
    AND contype = 'f'
    AND NOT convalidated;

  IF unvalidated IS NOT NULL THEN
    RAISE EXCEPTION '0822: companion FKs not yet validated — run 0815 first: %', unvalidated;
  END IF;
END $$;
--> statement-breakpoint

-- mail_message_metadata: drop FK constraint then column
-- (FK name from 0815 is mail_message_metadata_user_id_fkey on the users.id reference)
ALTER TABLE mail_message_metadata DROP CONSTRAINT IF EXISTS mail_message_metadata_user_id_fkey;
--> statement-breakpoint
ALTER TABLE mail_message_metadata DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- worker_engagements: drop FK constraint then column
ALTER TABLE worker_engagements DROP CONSTRAINT IF EXISTS worker_engagements_created_by_fkey;
--> statement-breakpoint
ALTER TABLE worker_engagements DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint

-- Recreate mail indexes that used user_id (auto-dropped with the column)
CREATE INDEX IF NOT EXISTS idx_mail_metadata_list
  ON mail_message_metadata (org_id, user_membership_id, folder, date DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mail_metadata_thread
  ON mail_message_metadata (org_id, user_membership_id, thread_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mail_metadata_search
  ON mail_message_metadata (org_id, user_membership_id, synced_at DESC);
--> statement-breakpoint

-- Post-flight: confirm legacy columns are gone
DO $$
DECLARE
  still_present text;
BEGIN
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO still_present
  FROM (VALUES
    ('mail_message_metadata', 'user_id'),
    ('worker_engagements', 'created_by')
  ) AS t(tbl, col)
  WHERE EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF still_present IS NOT NULL THEN
    RAISE EXCEPTION '0822: legacy columns still present: %', still_present;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mail_message_metadata' AND column_name = 'user_membership_id'
  ) THEN
    RAISE EXCEPTION '0822: mail_message_metadata.user_membership_id companion missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'worker_engagements' AND column_name = 'created_by_membership_id'
  ) THEN
    RAISE EXCEPTION '0822: worker_engagements.created_by_membership_id companion missing';
  END IF;
END $$;
