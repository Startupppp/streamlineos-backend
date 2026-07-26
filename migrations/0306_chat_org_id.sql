ALTER TABLE "chat_channel_members" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_channel_members" t SET "org_id" = c."org_id" FROM "chat_channels" c WHERE t."channel_id" = c."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_channel_members" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_channel_members" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_channel_members_org" ON "chat_channel_members" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_channel_members" ADD CONSTRAINT "uniq_chat_channel_members_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_messages" t SET "org_id" = c."org_id" FROM "chat_channels" c WHERE t."channel_id" = c."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_messages" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_messages_org" ON "chat_messages" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "uniq_chat_messages_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_pinned_messages" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_pinned_messages" t SET "org_id" = c."org_id" FROM "chat_channels" c WHERE t."channel_id" = c."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_pinned_messages" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_pinned_messages" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_pinned_messages_org" ON "chat_pinned_messages" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "uniq_chat_pinned_messages_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_huddles" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_huddles" t SET "org_id" = c."org_id" FROM "chat_channels" c WHERE t."channel_id" = c."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_huddles" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_huddles" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_huddles" ADD CONSTRAINT "chat_huddles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_huddles_org" ON "chat_huddles" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_huddles" ADD CONSTRAINT "uniq_chat_huddles_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_channel_invite_links" t SET "org_id" = c."org_id" FROM "chat_channels" c WHERE t."channel_id" = c."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_channel_invite_links" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_channel_invite_links" ADD CONSTRAINT "chat_channel_invite_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_channel_invite_links_org" ON "chat_channel_invite_links" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_channel_invite_links" ADD CONSTRAINT "uniq_chat_channel_invite_links_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_attachments" t SET "org_id" = c."org_id" FROM "chat_messages" msg JOIN "chat_channels" c ON msg."channel_id" = c."id" WHERE t."message_id" = msg."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_attachments" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_attachments" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_attachments_org" ON "chat_attachments" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_attachments" ADD CONSTRAINT "uniq_chat_attachments_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_saved_messages" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_saved_messages" t SET "org_id" = c."org_id" FROM "chat_messages" msg JOIN "chat_channels" c ON msg."channel_id" = c."id" WHERE t."message_id" = msg."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_saved_messages" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_saved_messages" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_saved_messages" ADD CONSTRAINT "chat_saved_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_saved_messages_org" ON "chat_saved_messages" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_saved_messages" ADD CONSTRAINT "uniq_chat_saved_messages_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chat_huddle_participants" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "chat_huddle_participants" t SET "org_id" = c."org_id" FROM "chat_huddles" h JOIN "chat_channels" c ON h."channel_id" = c."id" WHERE t."huddle_id" = h."id" AND t."org_id" IS NULL;
--> statement-breakpoint
DELETE FROM "chat_huddle_participants" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_huddle_participants" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_huddle_participants" ADD CONSTRAINT "chat_huddle_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_huddle_participants_org" ON "chat_huddle_participants" ("org_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_huddle_participants" ADD CONSTRAINT "uniq_chat_huddle_participants_org_id" UNIQUE ("org_id","id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
