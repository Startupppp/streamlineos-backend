-- Reverses 1097. Points Build's five CRM keys back at `contacts`,
-- `clients` and `crm_organizations`, with `fk_tickets_customer` restored
-- beside `fk_tickets_customer_id_org` exactly as the catalogue had them —
-- including the contradiction between the two, which is part of the state
-- being restored and not an accident of this file.
--
-- Read this before running it: the rollback restores a known breakage. The
-- legacy tables are not written (0277, ticket 25, 1093), so with these keys
-- back, setting a Build ticket's Customer or a feedback post's or Feedbucket
-- submission's CRM contact or company fails SQLSTATE 23503 for any record
-- created since the cutover, and the request returns 500.
--
-- The legacy keys are added NOT VALID and never validated. Rows written since
-- 1097 name map-minted ids that have no legacy row, so a validating ADD would
-- fail on existing data and the rollback could not run. Every ADD follows a
-- DROP IF EXISTS, so a re-run is a no-op.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer_id_org";
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer";
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer"
  FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_id_org"
  FOREIGN KEY ("org_id", "customer_id") REFERENCES "public"."crm_organizations"("org_id", "id") NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact"
  FOREIGN KEY ("crm_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization"
  FOREIGN KEY ("crm_organization_id") REFERENCES "public"."crm_organizations"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact"
  FOREIGN KEY ("crm_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

-- Restored under its original name, `..._crm_org`, not the `..._crm_organization`
-- the sibling keys use. 1097 dropped both spellings; this puts back the one the
-- catalogue actually had.
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_organization_id_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_org";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_org"
  FOREIGN KEY ("crm_organization_id") REFERENCES "public"."crm_organizations"("id") ON DELETE SET NULL NOT VALID;
