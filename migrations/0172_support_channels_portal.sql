DO $$ BEGIN
  CREATE TYPE "support_channel_type" AS ENUM ('email', 'chat', 'whatsapp', 'sms');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "support_source_channel" AS ENUM ('web', 'portal', 'email', 'chat', 'whatsapp', 'sms', 'api', 'internal');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "source_channel" text DEFAULT 'web' NOT NULL;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "source_message_id" text;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "requester_email" text;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "requester_name" text;

ALTER TABLE "support_ticket_messages" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "support_ticket_messages" ADD COLUMN IF NOT EXISTS "source_channel" text DEFAULT 'web' NOT NULL;
ALTER TABLE "support_ticket_messages" ADD COLUMN IF NOT EXISTS "source_message_id" text;
ALTER TABLE "support_ticket_messages" ADD COLUMN IF NOT EXISTS "source_contact_email" text;
ALTER TABLE "support_ticket_messages" ADD COLUMN IF NOT EXISTS "source_contact_name" text;

CREATE INDEX IF NOT EXISTS "idx_support_tickets_source_message" ON "support_tickets" ("source_message_id");
CREATE INDEX IF NOT EXISTS "idx_support_ticket_messages_source_message" ON "support_ticket_messages" ("source_message_id");

CREATE TABLE IF NOT EXISTS "support_channels" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "type" "support_channel_type" NOT NULL,
  "name" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "inbound_secret" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "support_channels" ADD CONSTRAINT "support_channels_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_support_channels_org_type" ON "support_channels" ("org_id", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_channels_org_type_name" ON "support_channels" ("org_id", "type", "name");
