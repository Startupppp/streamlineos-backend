-- S08: chat_channels carries both is_private and type, and different services branch
-- on different columns. createChannel set is_private only for type='PRIVATE', so a
-- DIRECT message and an invite-only GROUP both stored is_private=false — and the
-- membership guard reads is_private to choose 404 over 403, so a non-member probing a
-- DM was answered 403, which confirms the conversation exists. Backfill first, then
-- constrain, so the two columns can no longer disagree.

SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE "chat_channels" SET "is_private" = ("type" <> 'PUBLIC') WHERE "is_private" IS DISTINCT FROM ("type" <> 'PUBLIC');
--> statement-breakpoint
ALTER TABLE "chat_channels" DROP CONSTRAINT IF EXISTS "chk_chat_channels_privacy_matches_type";
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chk_chat_channels_privacy_matches_type" CHECK ("is_private" = ("type" <> 'PUBLIC'));
