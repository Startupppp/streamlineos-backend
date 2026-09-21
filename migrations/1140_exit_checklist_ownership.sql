-- 1140 — one offboarding checklist per exit: typed items, an owner (membership or named
-- queue), a due date, completion evidence and who closed it.
--
-- `exit_checklists` rows were free text seeded from a template with no owner, no due date and
-- no key a client could address. The typed key makes seeding idempotent and lets a PATCH name an
-- item; legacy rows get a key derived from their id so nothing is unaddressable.
--
-- `ALTER TYPE … ADD VALUE` is legal inside a transaction from PostgreSQL 12 on as long as the new
-- label is not used before commit; nothing below writes 'WAIVED'.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TYPE "public"."exit_checklist_status" ADD VALUE IF NOT EXISTS 'WAIVED';
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "item_key" text;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "owner_queue" text;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "due_date" date;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "evidence" text;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "completed_by_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
UPDATE "exit_checklists" SET "item_key" = 'custom-' || "id"::text WHERE "item_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD CONSTRAINT "chk_exit_checklists_item_key_not_null" CHECK ("item_key" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "exit_checklists" VALIDATE CONSTRAINT "chk_exit_checklists_item_key_not_null";
--> statement-breakpoint
ALTER TABLE "exit_checklists" ALTER COLUMN "item_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP CONSTRAINT "chk_exit_checklists_item_key_not_null";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exit_checklists_org_resignation_item_key" ON "exit_checklists" ("org_id", "resignation_id", "item_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_exit_checklists_org_assignee_status" ON "exit_checklists" ("org_id", "assigned_to_membership_id", "status");
