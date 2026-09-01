-- 0912: Contract research-brief ownership to organization membership identity.
-- Expand/backfill completed in 0852 and the existing FK was validated in 0854.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "kb_research_briefs"
    WHERE "user_membership_id" IS NULL
  ) THEN
    RAISE EXCEPTION '0912 blocked: KB research brief membership backfill is incomplete';
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  DROP CONSTRAINT IF EXISTS "fk_kb_research_briefs_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  ADD CONSTRAINT "fk_kb_research_briefs_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  VALIDATE CONSTRAINT "fk_kb_research_briefs_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  ADD CONSTRAINT "chk_kb_research_briefs_membership_not_null"
  CHECK ("user_membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  VALIDATE CONSTRAINT "chk_kb_research_briefs_membership_not_null";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  ALTER COLUMN "user_membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  DROP CONSTRAINT "chk_kb_research_briefs_membership_not_null";

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_research_briefs_org_user";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "kb_chat_conversations" WHERE "user_membership_id" IS NULL) THEN
    RAISE EXCEPTION '0912 blocked: KB chat conversation membership backfill is incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM "kb_chat_messages" WHERE "user_membership_id" IS NULL) THEN
    RAISE EXCEPTION '0912 blocked: KB chat message membership backfill is incomplete';
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  DROP CONSTRAINT IF EXISTS "fk_kb_chat_conv_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  ADD CONSTRAINT "fk_kb_chat_conv_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  VALIDATE CONSTRAINT "fk_kb_chat_conv_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  DROP CONSTRAINT IF EXISTS "fk_kb_chat_msg_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  ADD CONSTRAINT "fk_kb_chat_msg_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  VALIDATE CONSTRAINT "fk_kb_chat_msg_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  ADD CONSTRAINT "chk_kb_chat_conversations_membership_not_null"
  CHECK ("user_membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  VALIDATE CONSTRAINT "chk_kb_chat_conversations_membership_not_null";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  ALTER COLUMN "user_membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  DROP CONSTRAINT "chk_kb_chat_conversations_membership_not_null";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  ADD CONSTRAINT "chk_kb_chat_messages_membership_not_null"
  CHECK ("user_membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  VALIDATE CONSTRAINT "chk_kb_chat_messages_membership_not_null";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  ALTER COLUMN "user_membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  DROP CONSTRAINT "chk_kb_chat_messages_membership_not_null";

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_chat_conversations_org_user_updated";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chat_conversations_org_mbr_updated"
  ON "kb_chat_conversations" ("org_id", "user_membership_id", "updated_at" DESC, "id" DESC);

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_chat_messages_org_user_id";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  DROP COLUMN IF EXISTS "user_id";
