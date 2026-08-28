-- 0607 — vault_access_logs survives the deletion of the document it describes.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD COLUMN IF NOT EXISTS "candidate_id" integer;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD COLUMN IF NOT EXISTS "filename" text;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD COLUMN IF NOT EXISTS "document_type" text;
--> statement-breakpoint
UPDATE "vault_access_logs" AS l
SET "candidate_id" = v."candidate_id",
    "filename" = COALESCE(l."filename", v."filename"),
    "document_type" = COALESCE(l."document_type", v."document_type")
FROM "candidate_documents_vault" AS v
WHERE v."id" = l."vault_document_id"
  AND l."candidate_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "chk_vault_access_logs_candidate_id_present" CHECK ("candidate_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "chk_vault_access_logs_candidate_id_present";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ALTER COLUMN "candidate_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" DROP CONSTRAINT "chk_vault_access_logs_candidate_id_present";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "chk_vault_access_logs_filename_present" CHECK ("filename" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "chk_vault_access_logs_filename_present";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ALTER COLUMN "filename" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" DROP CONSTRAINT "chk_vault_access_logs_filename_present";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "vault_access_logs_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "vault_access_logs_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "fk_vault_access_logs_candidate_id_org" FOREIGN KEY ("org_id", "candidate_id") REFERENCES "candidates"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "fk_vault_access_logs_candidate_id_org";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ALTER COLUMN "vault_document_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" DROP CONSTRAINT "vault_access_logs_vault_document_id_candidate_documents_vault_i";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "vault_access_logs_vault_document_id_candidate_documents_vault_i" FOREIGN KEY ("vault_document_id") REFERENCES "candidate_documents_vault"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "vault_access_logs_vault_document_id_candidate_documents_vault_i";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" DROP CONSTRAINT "fk_vault_access_logs_vault_document_id_org";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "fk_vault_access_logs_vault_document_id_org" FOREIGN KEY ("org_id", "vault_document_id") REFERENCES "candidate_documents_vault"("org_id", "id") ON DELETE SET NULL ("vault_document_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "fk_vault_access_logs_vault_document_id_org";
--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "chk_vault_access_logs_action" CHECK ("action" IN ('VIEW', 'DOWNLOAD', 'DELETE')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "vault_access_logs" VALIDATE CONSTRAINT "chk_vault_access_logs_action";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vault_access_logs_org_candidate_accessed" ON "vault_access_logs" ("org_id", "candidate_id", "accessed_at" DESC);
