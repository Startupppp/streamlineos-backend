SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE chat_user_presence cup
SET membership_id = om.id
FROM organization_members om
WHERE om.org_id = cup.org_id
  AND om.user_id = cup.user_id
  AND cup.user_id IS NOT NULL
  AND cup.membership_id IS NULL;
--> statement-breakpoint
INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT
  cup.org_id,
  'chat_user_presence',
  cup.id::text,
  'unmappable_membership',
  jsonb_build_object('legacyUserId', cup.user_id)
FROM chat_user_presence cup
WHERE cup.membership_id IS NULL
  AND cup.user_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_presence_org_membership
  ON chat_user_presence (org_id, membership_id)
  WHERE membership_id IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chat_user_presence_org_membership') THEN
    ALTER TABLE chat_user_presence
      ADD CONSTRAINT fk_chat_user_presence_org_membership
      FOREIGN KEY (org_id, membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE chat_user_presence VALIDATE CONSTRAINT fk_chat_user_presence_org_membership;
