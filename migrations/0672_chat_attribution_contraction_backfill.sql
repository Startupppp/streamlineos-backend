-- L68: Wave L68-A — Chat attribution contraction (backfill + FK constraints).
-- Targets: chat_org_settings.updated_by  →  updated_by_membership_id
--          chat_channel_invite_links.created_by  →  created_by_membership_id
-- Classification: ATTRIBUTION on both columns (pure audit trail, no access decisions).
-- FK mode: SET NULL — a departed member's record stays; the application renders "Former Member"
--          when membership_id IS NULL.
--
-- Backfill batches: both tables are small (≤1 row per org / ≤few rows per channel).
-- A single UPDATE per table is safe; no cursor required.
--
-- NOT NULL relaxation: chat_channel_invite_links.created_by carries NOT NULL today.
-- We DROP NOT NULL here so the cutover commit can stop writing the legacy column without a
-- simultaneous deployment window; migration 0673 removes the column itself.
SET lock_timeout = '5s';
--> statement-breakpoint
-- 1. Backfill chat_org_settings.updated_by_membership_id
UPDATE chat_org_settings cos
SET updated_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = cos.org_id
  AND om.user_id = cos.updated_by
  AND cos.updated_by IS NOT NULL
  AND cos.updated_by_membership_id IS NULL;
--> statement-breakpoint
-- 2. Backfill chat_channel_invite_links.created_by_membership_id
UPDATE chat_channel_invite_links cil
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = cil.org_id
  AND om.user_id = cil.created_by
  AND cil.created_by IS NOT NULL
  AND cil.created_by_membership_id IS NULL;
--> statement-breakpoint
-- 3. Relax NOT NULL on legacy column so cutover can proceed without a deploy window.
--    Migration 0673 drops the column; the NOT NULL is not restored.
ALTER TABLE chat_channel_invite_links ALTER COLUMN created_by DROP NOT NULL;
--> statement-breakpoint
-- 4. FK: chat_org_settings.updated_by_membership_id (ATTR → SET NULL)
ALTER TABLE chat_org_settings DROP CONSTRAINT IF EXISTS fk_chat_org_settings_updated_by_membership;
--> statement-breakpoint
ALTER TABLE chat_org_settings ADD CONSTRAINT fk_chat_org_settings_updated_by_membership
  FOREIGN KEY (org_id, updated_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_org_settings VALIDATE CONSTRAINT fk_chat_org_settings_updated_by_membership;
--> statement-breakpoint
-- 5. FK: chat_channel_invite_links.created_by_membership_id (ATTR → SET NULL)
ALTER TABLE chat_channel_invite_links DROP CONSTRAINT IF EXISTS fk_chat_invite_links_created_by_membership;
--> statement-breakpoint
ALTER TABLE chat_channel_invite_links ADD CONSTRAINT fk_chat_invite_links_created_by_membership
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_channel_invite_links VALIDATE CONSTRAINT fk_chat_invite_links_created_by_membership;
