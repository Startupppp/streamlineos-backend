-- Rollback for 1198_document_classification. Destructive: the classification a person chose is lost.
-- Run the rollbacks of 1202, then 1201 first (the trigger and function that read these columns are 1201's), then 1200's.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."documents" DROP COLUMN IF EXISTS "effective_date";
--> statement-breakpoint

ALTER TABLE "public"."documents" DROP COLUMN IF EXISTS "classification";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."document_classification";
