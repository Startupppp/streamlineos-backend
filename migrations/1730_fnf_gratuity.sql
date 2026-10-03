SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN IF NOT EXISTS "gratuity" numeric(15,2) NOT NULL DEFAULT 0;
