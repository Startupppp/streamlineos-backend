CREATE TABLE IF NOT EXISTS "user_calendar_connections" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "expires_at" timestamp,
  "provider_email" text,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uq_calendar_connections_user_account" UNIQUE NULLS NOT DISTINCT ("user_id", "provider", "provider_email")
);
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_calendar_connections_user_id_users_id_fk') THEN
    ALTER TABLE "user_calendar_connections"
      ADD CONSTRAINT "user_calendar_connections_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
-- @@SPLIT@@
ALTER TABLE "user_calendar_connections" ADD COLUMN IF NOT EXISTS "is_primary" boolean NOT NULL DEFAULT false;
-- @@SPLIT@@
ALTER TABLE "user_calendar_connections" DROP CONSTRAINT IF EXISTS "uq_calendar_connections_user_provider";
-- @@SPLIT@@
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_calendar_connections_user_account') THEN
    ALTER TABLE "user_calendar_connections"
      ADD CONSTRAINT "uq_calendar_connections_user_account"
      UNIQUE NULLS NOT DISTINCT ("user_id", "provider", "provider_email");
  END IF;
END $$;
-- @@SPLIT@@
CREATE INDEX IF NOT EXISTS "idx_calendar_connections_user" ON "user_calendar_connections" ("user_id");
-- @@SPLIT@@
UPDATE "user_calendar_connections" c
SET "is_primary" = true
WHERE NOT EXISTS (
  SELECT 1 FROM "user_calendar_connections" o
  WHERE o."user_id" = c."user_id" AND o."is_primary" = true
)
AND c."id" = (
  SELECT MIN(m."id") FROM "user_calendar_connections" m WHERE m."user_id" = c."user_id"
);
