-- 1054 DOWN — returns uniq_chat_presence_org_membership to the PARTIAL form
-- migration 0713 created.
--
-- @reopens-a-defect: the partial predicate is what `ON CONFLICT (org_id,
-- membership_id)` cannot infer. Running this puts every chat presence write back
-- on SQLSTATE 42P10 at PLAN time — POST /chat/presence/heartbeat and
-- PUT /chat/status 500 for every caller in every tenant. Revert the two upserts in
-- src/modules/chat/chat-presence.service.ts to carry `targetWhere` in the same
-- change, or do not run this file.
--
-- No data is at risk in either direction. `WHERE membership_id IS NOT NULL` on a
-- UNIQUE index whose key contains membership_id is a no-op as a constraint (NULL
-- keys never collide), and membership_id has been NOT NULL since 0762, so the two
-- forms admit exactly the same rows. This file changes inferability, nothing else.
--
-- DROP THEN CREATE for the same reason as the forward file: drizzle-kit wraps it in
-- one transaction and DROP INDEX holds ACCESS EXCLUSIVE on chat_user_presence until
-- COMMIT, so no concurrent writer sees the table without a unique index.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_chat_presence_org_membership";
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_chat_presence_org_membership"
  ON "chat_user_presence" ("org_id", "membership_id")
  WHERE "membership_id" IS NOT NULL;
