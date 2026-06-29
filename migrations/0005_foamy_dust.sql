CREATE TYPE "public"."lead_priority" AS ENUM('HOT', 'WARM', 'COLD');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "priority" "lead_priority" DEFAULT 'WARM';