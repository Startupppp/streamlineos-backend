-- Rollback for migration 1140.
--
-- PostgreSQL cannot remove a label from an enum, so 'WAIVED' stays on
-- exit_checklist_status; rows carrying it are reset to PENDING first so the
-- older code, which knows only PENDING and DONE, never reads a label it
-- cannot classify.

SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE "exit_checklists" SET "status" = 'PENDING' WHERE "status" = 'WAIVED';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_exit_checklists_org_assignee_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_exit_checklists_org_resignation_item_key";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "updated_at";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "completed_by_membership_id";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "evidence";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "due_date";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "owner_queue";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "item_key";
