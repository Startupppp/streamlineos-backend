CREATE TABLE IF NOT EXISTS "chat_channel_invite_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "channel_id" integer NOT NULL REFERENCES "chat_channels"("id") ON DELETE cascade,
  "token" text NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "revoked_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_invite_link_token" ON "chat_channel_invite_links" ("token");
CREATE INDEX IF NOT EXISTS "idx_chat_invite_links_channel" ON "chat_channel_invite_links" ("channel_id", "revoked_at");
