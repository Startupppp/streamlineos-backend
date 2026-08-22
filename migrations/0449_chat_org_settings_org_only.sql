-- Organisation-wide chat settings belong to the organisation owner and organisation admins only.
-- Both already hold the whole catalog structurally (access-permission.resolver.ts), so nothing has
-- to be granted to them and this revokes rather than re-grants.
--
-- Why there is anything to revoke: migration 0437 granted `chat:org-settings:manage` to the system
-- role CHAT_MODULE_ADMIN in every organisation. 0441 replaced the three per-module ladders with one
-- Home ladder, but deliberately only deleted roles that nobody had been assigned to, so any
-- organisation that had actually appointed a chat module admin still carries the grant.
--
-- The permission key itself stays in the catalog: the route
-- (@RequirePermission("chat:org-settings:manage")) needs it, and owners/org admins resolve it from
-- the full catalog. Code-side, grantability.ts now refuses the key on every grant path, so this
-- cannot come back.
SET lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "permission_key" = 'chat:org-settings:manage';
--> statement-breakpoint
DELETE FROM "user_permission_grants"
WHERE "permission_key" = 'chat:org-settings:manage';
--> statement-breakpoint
DELETE FROM "user_delegation_permissions"
WHERE "permission_key" = 'chat:org-settings:manage';
--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by permissions_version, so anyone who just
-- lost the key must not keep it until their cache expires.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
