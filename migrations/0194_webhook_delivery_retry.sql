-- Add retry-tracking columns to webhook_deliveries (additive, idempotent-safe)
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
