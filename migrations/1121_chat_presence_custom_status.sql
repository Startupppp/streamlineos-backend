SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."chat_user_presence" ADD COLUMN IF NOT EXISTS "status_message" text;
--> statement-breakpoint
ALTER TABLE "public"."chat_user_presence" ADD COLUMN IF NOT EXISTS "status_expires_at" timestamp;
