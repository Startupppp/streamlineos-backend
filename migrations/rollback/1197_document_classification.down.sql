-- Rollback for 1197_document_classification. Destructive: the classification a person chose is lost.
-- Run 1199's rollback first: its trigger and function read these columns.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."documents" DROP COLUMN IF EXISTS "effective_date";
--> statement-breakpoint

ALTER TABLE "public"."documents" DROP COLUMN IF EXISTS "classification";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."document_classification";
