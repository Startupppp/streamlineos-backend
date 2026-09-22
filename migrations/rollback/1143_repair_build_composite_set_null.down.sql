SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_contact_party_id";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact_party_id"
  FOREIGN KEY ("org_id", "crm_contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_contact_party_id";
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts" DROP CONSTRAINT IF EXISTS "fk_feedback_posts_crm_organization_party_id";
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization_party_id"
  FOREIGN KEY ("org_id", "crm_organization_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_organization_party_id";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_contact_party_id";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact_party_id"
  FOREIGN KEY ("org_id", "crm_contact_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_contact_party_id";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_crm_organization_party_id";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_organization_party_id"
  FOREIGN KEY ("org_id", "crm_organization_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_organization_party_id";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_widgets" DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_default_assignee";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT "fk_feedbucket_widgets_org_default_assignee"
  FOREIGN KEY ("org_id", "default_assignee_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_org_default_assignee";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_widgets" DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_org_default_project";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT "fk_feedbucket_widgets_org_default_project"
  FOREIGN KEY ("org_id", "default_project_id")
  REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_org_default_project";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer_org_party_id";
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_org_party_id"
  FOREIGN KEY ("org_id", "customer_org_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_org_party_id";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_customer_party_id";
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_party_id"
  FOREIGN KEY ("org_id", "customer_party_id")
  REFERENCES "public"."business_parties" ("organization_id", "party_id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_customer_party_id";

