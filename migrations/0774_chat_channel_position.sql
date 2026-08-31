SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN IF NOT EXISTS "message_count" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "chat_channels" c
SET "message_count" = (
  SELECT count(*) FROM "chat_messages" m
  WHERE m."channel_id" = c."id" AND m."org_id" = c."org_id"
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "channel_position" bigint;
--> statement-breakpoint
UPDATE "chat_messages" m
SET "channel_position" = sub.pos
FROM (
  SELECT "id", "org_id",
         row_number() OVER (PARTITION BY "org_id", "channel_id" ORDER BY "id") AS pos
  FROM "chat_messages"
) sub
WHERE m."id" = sub."id" AND m."org_id" = sub."org_id" AND m."channel_position" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chk_chat_messages_channel_position_not_null"
  CHECK ("channel_position" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_messages" VALIDATE CONSTRAINT "chk_chat_messages_channel_position_not_null";
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "channel_position" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "channel_position" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chk_chat_messages_channel_position_not_null";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_channel_position"
  ON "chat_messages" ("org_id", "channel_id", "channel_position" DESC)
  WHERE "is_deleted" = false;
--> statement-breakpoint

DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "chat_messages" WHERE "channel_position" IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '0774: % chat_messages rows still have a null channel_position', bad;
  END IF;

  SELECT count(*) INTO bad
  FROM (
    SELECT "org_id", "channel_id", "channel_position"
    FROM "chat_messages"
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  ) dupes;
  IF bad > 0 THEN
    RAISE EXCEPTION '0774: % duplicate (org_id, channel_id, channel_position) groups — ordering would be ambiguous', bad;
  END IF;
END $$;
