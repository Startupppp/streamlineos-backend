SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_settings" ADD COLUMN IF NOT EXISTS "chat_history_retention_days" integer DEFAULT 90;
