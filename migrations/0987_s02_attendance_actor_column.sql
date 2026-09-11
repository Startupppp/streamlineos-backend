-- S02: the last Drizzle-declared actor column with no database column; without it db.select() on attendance renders user_membership_id and fails 42703.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
