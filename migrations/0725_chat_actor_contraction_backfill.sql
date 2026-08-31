SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE chat_channel_members t
SET membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_id IS NOT NULL
  AND t.membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_messages t
SET sender_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.sender_id
  AND t.sender_id IS NOT NULL
  AND t.sender_membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_channels t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_pinned_messages t
SET pinned_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.pinned_by
  AND t.pinned_by IS NOT NULL
  AND t.pinned_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_saved_messages t
SET membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_id IS NOT NULL
  AND t.membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_huddles t
SET started_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.started_by
  AND t.started_by IS NOT NULL
  AND t.started_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_huddle_participants t
SET membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_id IS NOT NULL
  AND t.membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_user_presence t
SET membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_id IS NOT NULL
  AND t.membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_reply_reminders t
SET recipient_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.recipient_user_id
  AND t.recipient_user_id IS NOT NULL
  AND t.recipient_membership_id IS NULL;
--> statement-breakpoint
UPDATE chat_reply_reminders t
SET sender_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.sender_user_id
  AND t.sender_user_id IS NOT NULL
  AND t.sender_membership_id IS NULL;
