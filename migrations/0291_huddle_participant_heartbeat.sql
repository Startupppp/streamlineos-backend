ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp DEFAULT now() NOT NULL;
