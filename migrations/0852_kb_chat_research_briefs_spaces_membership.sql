-- 0852: EXPAND kb_chat_conversations, kb_chat_messages, kb_research_briefs and kb_spaces
-- with user/created_by membership_id columns.
--
-- kb_chat_conversations.user_id and kb_chat_messages.user_id are used in WHERE predicates
-- inside kb-chat-history.service.ts for ownership checks, meaning a revoked member can still
-- satisfy the predicate. Moving the ownership link to organization_members.id makes revocation
-- actually revoke: when a membership row is soft-deleted, SET NULL fires on the column (column-list
-- syntax, PG 15+), so eq(userMembershipId, actorMembershipId) never matches NULL.
--
-- kb_research_briefs.user_id is used in WHERE in kb-research-brief.service.ts.
-- kb_spaces.created_by_id is used via applyScope ownerColumn in kb-spaces.service.ts.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Legacy user_id / created_by_id columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer;

--> statement-breakpoint
UPDATE "kb_chat_conversations" kcc
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = kcc.org_id
  AND om.user_id = kcc.user_id
  AND kcc."user_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "kb_chat_messages" kcm
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = kcm.org_id
  AND om.user_id = kcm.user_id
  AND kcm."user_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "kb_research_briefs" krb
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = krb.org_id
  AND om.user_id = krb.user_id
  AND krb.user_id IS NOT NULL
  AND krb."user_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "kb_spaces" ks
SET "created_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = ks.org_id
  AND om.user_id = ks.created_by_id
  AND ks.created_by_id IS NOT NULL
  AND ks."created_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  ADD CONSTRAINT "fk_kb_chat_conv_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  ADD CONSTRAINT "fk_kb_chat_msg_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  ADD CONSTRAINT "fk_kb_research_briefs_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_spaces"
  ADD CONSTRAINT "fk_kb_spaces_org_created_by_mbr"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chat_conversations_org_mbr"
  ON "kb_chat_conversations" ("org_id", "user_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chat_messages_org_mbr"
  ON "kb_chat_messages" ("org_id", "user_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_research_briefs_org_mbr"
  ON "kb_research_briefs" ("org_id", "user_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_spaces_org_created_by_mbr"
  ON "kb_spaces" ("org_id", "created_by_membership_id");
