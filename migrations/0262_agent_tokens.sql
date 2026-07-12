CREATE TABLE IF NOT EXISTS "agent_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uniq_agent_tokens_hash'
  ) THEN
    CREATE UNIQUE INDEX "uniq_agent_tokens_hash" ON "agent_tokens" ("token_hash");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_agent_tokens_org_user'
  ) THEN
    CREATE INDEX "idx_agent_tokens_org_user" ON "agent_tokens" ("org_id", "user_id");
  END IF;
END $$;
