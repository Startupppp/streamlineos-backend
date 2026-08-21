-- Ticket 10 split five chat capabilities and the org calendar export onto their own keys, so they
-- can be delegated separately. The routes now demand the narrow key, but role templates only grant
-- on role CREATION, so without this backfill every member of an EXISTING organisation would silently
-- lose huddles, pinning, invite links and calendar export the moment this ships.
-- The catalog rows are inserted here rather than left to the boot-time catalog sync, because a grant
-- referencing a key the `permissions` table does not yet hold is skipped, and the backfill would be
-- a silent no-op depending on deploy order.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('chat:messages:pin', 'chat:messages', 'pin', 'Pin or unpin messages in a channel', 'chat'),
  ('chat:huddles:start', 'chat:huddles', 'start', 'Start a voice or video huddle in a channel', 'chat'),
  ('chat:huddles:moderate', 'chat:huddles', 'moderate', 'Kick participants from an active huddle', 'chat'),
  ('chat:invite-links:manage', 'chat:invite-links', 'manage', 'Mint or regenerate channel invite links', 'chat'),
  ('chat:org-settings:manage', 'chat:org-settings', 'manage', 'Manage organisation-wide chat settings', 'chat'),
  ('calendar:events:export', 'calendar:events', 'export', 'Export organisation calendar events as CSV', 'calendar')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- Every member holds these today through the broader chat/calendar keys; keep it that way.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('chat:messages:pin'),
  ('chat:huddles:start'),
  ('chat:invite-links:manage'),
  ('calendar:events:export')
) AS k("permission_key")
WHERE r."is_system" = true AND r."slug" = 'MEMBER'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Huddle moderation and org-wide chat settings are deliberately administrative.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('chat:messages:pin'),
  ('chat:huddles:start'),
  ('chat:huddles:moderate'),
  ('chat:invite-links:manage'),
  ('chat:org-settings:manage')
) AS k("permission_key")
WHERE r."is_system" = true AND r."slug" = 'CHAT_MODULE_ADMIN'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('MEMBER', 'CHAT_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
