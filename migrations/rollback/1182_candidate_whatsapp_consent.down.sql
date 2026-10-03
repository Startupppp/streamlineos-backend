SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_candidates_org_phone";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "whatsapp_opt_out_at";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "whatsapp_opt_in_at";
