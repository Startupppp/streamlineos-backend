-- 1046 DOWN -- restores support_ticket_watchers."user_id" and its legacy constraints.
--
-- @reopens-a-defect: this is not a neutral reversal. Restoring "user_id" NOT NULL
-- reinstates the exact production defect 1046 closed. The Drizzle declaration in
-- src/db/schema/support/support-workspace.ts does not declare "user_id", so as soon as
-- this column is back and NOT NULL, every insert from SupportWorkspaceService.follow omits
-- it and Postgres raises 23502 -- POST /support/:supportTicketId/follow answers 500 for
-- every caller in every tenant again. Do not run this without reverting that declaration in
-- the same change.
--
-- @data-loss: the rows 1046 deleted -- watchers whose (org_id, user_id) had no
-- organization_members row -- are NOT restored. Nothing left in the database records who
-- they were, because the membership pointer is the only actor identity that survived. The
-- values this file writes back into "user_id" are reconstructed from
-- organization_members.user_id via "user_membership_id"; that reproduces the identity for
-- every row 1046 kept, and nothing at all for a row it removed.
--
-- Restoring the legacy unique index uniq_support_ticket_watchers_ticket_user
-- (ticket_id, user_id) can also fail where 1046's backfill collapsed two memberships of the
-- same user onto one row. The index is created without CONCURRENTLY, matching the forward
-- migration's constraint that drizzle-kit wraps each migration in a transaction.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint

UPDATE "support_ticket_watchers" w
SET "user_id" = om.user_id
FROM "organization_members" om
WHERE om.org_id = w.org_id
  AND om.id = w."user_membership_id"
  AND w."user_id" IS NULL;
--> statement-breakpoint

DELETE FROM "support_ticket_watchers" WHERE "user_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ADD CONSTRAINT "ck_support_ticket_watchers_user_id_nn"
  CHECK ("user_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  VALIDATE CONSTRAINT "ck_support_ticket_watchers_user_id_nn";
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  DROP CONSTRAINT "ck_support_ticket_watchers_user_id_nn";
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ADD CONSTRAINT "support_ticket_watchers_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  VALIDATE CONSTRAINT "support_ticket_watchers_user_id_users_id_fk";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_watchers_ticket_user"
  ON "support_ticket_watchers" ("ticket_id", "user_id");
--> statement-breakpoint

ALTER TABLE "support_ticket_watchers"
  ALTER COLUMN "user_membership_id" DROP NOT NULL;
