-- 1077 — the huddle transport becomes a Google Meet link, and the mesh columns go with it.
--
-- WHAT CHANGES. `chat_huddles` gains `meeting_url`: the `hangoutLink` Google returns from
-- GOOGLECALENDAR_CREATE_EVENT when the event is created with `create_meeting_room: true`,
-- minted synchronously at start and returned in the start response. Six columns that existed
-- only to carry per-peer WebRTC state are dropped.
--
-- WHY THE COLUMN IS NULLABLE. Every huddle started from here on carries a link — the start
-- path refuses rather than opening a call nobody can join — but rows already in the table have
-- no link and never will, so NOT NULL is unrepresentable without inventing one. `meeting_url`
-- is therefore nullable, and `huddleWireSchema` publishes it as `string().url().nullable()`.
--
-- WHAT IS DROPPED, AND WHAT THAT COSTS.
--   chat_huddles.has_video                    — written once (always false), read nowhere.
--   chat_huddle_participants.is_camera_off     — referenced by no service, no route, no read.
--   chat_huddle_participants.is_muted          — PATCH /chat/huddles/:id/mute, removed.
--   chat_huddle_participants.hand_raised       — PATCH /chat/huddles/:id/hand, removed.
--   chat_huddle_participants.is_screen_sharing — PATCH /chat/huddles/:id/screenshare, removed.
--   chat_huddle_participants.is_deafened       — PATCH /chat/huddles/:id/deafen, removed.
-- Mute, hand, screen share and deafen are states of the Google Meet call from here on; this
-- server cannot observe them and must not claim a stale copy. The values are DESTROYED — see
-- the rollback, which restores the columns and their defaults but cannot restore a single row's
-- prior value.
--
-- WHAT IS KEPT AND WHY. `last_seen_at` stays. Meet gives us no roster: the only answer to
-- "is this huddle still running" remains `chat_huddle_participants`, reaped at
-- STALE_PARTICIPANT_MS = 90s by the heartbeat. Dropping it would leave a closed tab in the
-- huddle until HUDDLE_MAX_DURATION_MS (12h), which is a visible product regression, so the
-- ~2 writes/minute/participant is paid deliberately.
--
-- CASCADES ARE UNTOUCHED. fk_chat_huddles_org_starter_membership and
-- fk_chat_huddle_participants_org_membership remain ON DELETE CASCADE, so a revoked membership
-- still hard-deletes its huddles and participant rows exactly as before this migration. That
-- pre-existing retention behaviour is neither improved nor worsened here.
--
-- LOCKING. Both ALTERs take ACCESS EXCLUSIVE, but a DROP COLUMN and a nullable ADD COLUMN are
-- catalog-only — no table rewrite — so the lock is held for microseconds once granted.
-- `lock_timeout` makes this fail fast rather than queue in front of the chat tables.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "chat_huddles" ADD COLUMN IF NOT EXISTS "meeting_url" text;
--> statement-breakpoint

ALTER TABLE "chat_huddles" DROP COLUMN IF EXISTS "has_video";
--> statement-breakpoint

ALTER TABLE "chat_huddle_participants" DROP COLUMN IF EXISTS "is_muted";
--> statement-breakpoint

ALTER TABLE "chat_huddle_participants" DROP COLUMN IF EXISTS "hand_raised";
--> statement-breakpoint

ALTER TABLE "chat_huddle_participants" DROP COLUMN IF EXISTS "is_camera_off";
--> statement-breakpoint

ALTER TABLE "chat_huddle_participants" DROP COLUMN IF EXISTS "is_screen_sharing";
--> statement-breakpoint

ALTER TABLE "chat_huddle_participants" DROP COLUMN IF EXISTS "is_deafened";
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success over a
-- statement that did nothing, and every IF EXISTS / IF NOT EXISTS clause above hides a no-op.
DO $$
DECLARE
  survivor text;
  missing boolean;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'chat_huddles'::regclass
       AND attname = 'meeting_url'
       AND NOT attisdropped
  ) INTO missing;
  IF missing THEN
    RAISE EXCEPTION '1077: chat_huddles.meeting_url was not added — every huddle would start with no way to join';
  END IF;

  FOR survivor IN
    SELECT a.attname
      FROM pg_attribute a
     WHERE a.attrelid = 'chat_huddle_participants'::regclass
       AND NOT a.attisdropped
       AND a.attname IN ('is_muted', 'hand_raised', 'is_camera_off', 'is_screen_sharing', 'is_deafened')
  LOOP
    RAISE EXCEPTION '1077: chat_huddle_participants.% survived the drop', survivor;
  END LOOP;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'chat_huddles'::regclass AND attname = 'has_video' AND NOT attisdropped;
  IF FOUND THEN
    RAISE EXCEPTION '1077: chat_huddles.has_video survived the drop';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'chat_huddle_participants'::regclass
     AND attname = 'last_seen_at' AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1077: chat_huddle_participants.last_seen_at is gone — the stale-participant reap has nothing to read and a closed tab stays in the huddle for 12 hours';
  END IF;

  PERFORM 1 FROM pg_constraint
   WHERE conname = 'fk_chat_huddles_org_starter_membership' AND confdeltype = 'c';
  IF NOT FOUND THEN
    RAISE EXCEPTION '1077: fk_chat_huddles_org_starter_membership changed — this migration must not alter huddle retention on membership revocation';
  END IF;
END
$$;
