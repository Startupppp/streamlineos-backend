CREATE TABLE IF NOT EXISTS "chat_reply_reminders" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE cascade,
  "message_id" integer NOT NULL REFERENCES "chat_messages"("id") ON DELETE cascade,
  "recipient_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "sender_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "remind_at" timestamp NOT NULL,
  "sent_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_reply_reminder" ON "chat_reply_reminders" ("message_id", "recipient_user_id");
CREATE INDEX IF NOT EXISTS "idx_chat_reply_reminders_due" ON "chat_reply_reminders" ("remind_at");
CREATE INDEX IF NOT EXISTS "idx_chat_reply_reminders_recipient" ON "chat_reply_reminders" ("recipient_user_id", "channel_id");
