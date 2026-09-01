-- 0920: S03 AI + Accounting actor contraction.
-- The legacy user columns remain as historical projections during this deploy.
-- Runtime authority is membership keyed; contract/drop follows after zero-use proof.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "ai_chat_conversations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
ALTER TABLE "ai_chat_messages" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
ALTER TABLE "ai_action_proposals" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "ai_chat_conversations" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.user_membership_id IS NULL;

UPDATE "ai_chat_messages" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.user_membership_id IS NULL;

UPDATE "ai_action_proposals" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.user_membership_id IS NULL;

--> statement-breakpoint
DO $$
DECLARE unmappable_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "ai_chat_conversations" WHERE "user_id" IS NOT NULL AND "user_membership_id" IS NULL) +
    (SELECT count(*) FROM "ai_chat_messages" WHERE "user_id" IS NOT NULL AND "user_membership_id" IS NULL) +
    (SELECT count(*) FROM "ai_action_proposals" WHERE "user_id" IS NOT NULL AND "user_membership_id" IS NULL)
  INTO unmappable_count;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0920 blocked: % AI actor row(s) cannot map to an organization membership', unmappable_count;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "ai_chat_conversations" DROP CONSTRAINT IF EXISTS "fk_ai_chat_conv_org_user_mbr";
ALTER TABLE "ai_chat_conversations" ADD CONSTRAINT "fk_ai_chat_conv_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL NOT VALID;

ALTER TABLE "ai_chat_messages" DROP CONSTRAINT IF EXISTS "fk_ai_chat_msg_org_user_mbr";
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "fk_ai_chat_msg_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL NOT VALID;

ALTER TABLE "ai_action_proposals" DROP CONSTRAINT IF EXISTS "fk_ai_proposals_org_user_mbr";
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "fk_ai_proposals_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ai_chat_conversations_org_user_membership_updated"
  ON "ai_chat_conversations" ("org_id", "user_membership_id", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_ai_chat_messages_org_user_membership_id"
  ON "ai_chat_messages" ("org_id", "user_membership_id", "id");
CREATE INDEX IF NOT EXISTS "idx_ai_proposals_org_user_membership_created"
  ON "ai_action_proposals" ("org_id", "user_membership_id", "created_at");

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" VALIDATE CONSTRAINT "fk_fin_approval_policies_org_mbr";
ALTER TABLE "journal_entries" VALIDATE CONSTRAINT "fk_je_org_created_by_mbr";
ALTER TABLE "ai_chat_conversations" VALIDATE CONSTRAINT "fk_ai_chat_conv_org_user_mbr";
ALTER TABLE "ai_chat_messages" VALIDATE CONSTRAINT "fk_ai_chat_msg_org_user_mbr";
ALTER TABLE "ai_action_proposals" VALIDATE CONSTRAINT "fk_ai_proposals_org_user_mbr";
