-- Rollback for 1077 — structurally reversible, NOT data-reversible.
--
-- WHAT COMES BACK. The five participant columns and chat_huddles.has_video are recreated with
-- their original types and DEFAULT false, and meeting_url is dropped.
--
-- WHAT DOES NOT COME BACK. Every value those six columns held is gone. 1077 issued
-- DROP COLUMN, which discards the data with the column; nothing was copied aside first, because
-- per-peer WebRTC state has a lifetime of one call and there is nothing to preserve. After this
-- rollback every participant reads is_muted = false, hand_raised = false, is_camera_off = false,
-- is_screen_sharing = false, is_deafened = false and every huddle reads has_video = false,
-- whatever they held before 1077 ran. A huddle that was live across the rollback comes back with
-- everyone unmuted, no hand raised and nobody presenting.
--
-- Every Meet link minted while 1077 was applied is destroyed here too: DROP COLUMN meeting_url
-- discards them, so a huddle still active at rollback loses its join URL permanently and the
-- pre-1077 WebRTC client is the only way back into it.

SET lock_timeout = '5s';

ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "is_muted" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "hand_raised" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "is_camera_off" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "is_screen_sharing" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "is_deafened" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_huddles" ADD COLUMN IF NOT EXISTS "has_video" boolean DEFAULT false NOT NULL;

ALTER TABLE "chat_huddles" DROP COLUMN IF EXISTS "meeting_url";

RESET lock_timeout;
