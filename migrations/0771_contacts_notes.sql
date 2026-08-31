SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "notes" text;
