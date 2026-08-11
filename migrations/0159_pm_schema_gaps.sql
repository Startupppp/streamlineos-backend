-- Custom SQL migration file, put your code below! --
SET lock_timeout = '5s';
--> statement-breakpoint

-- PM-001: CRM linkage on feedback_posts
ALTER TABLE "feedback_posts"
  ADD COLUMN "crm_contact_id" integer,
  ADD COLUMN "crm_organization_id" integer,
  ADD COLUMN "account_value_snapshot" numeric(15, 2);
--> statement-breakpoint

ALTER TABLE "feedback_posts"
  ADD CONSTRAINT "fk_feedback_posts_crm_contact"
    FOREIGN KEY ("crm_contact_id")
    REFERENCES "contacts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_contact";
--> statement-breakpoint

ALTER TABLE "feedback_posts"
  ADD CONSTRAINT "fk_feedback_posts_crm_organization"
    FOREIGN KEY ("crm_organization_id")
    REFERENCES "crm_organizations"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "feedback_posts" VALIDATE CONSTRAINT "fk_feedback_posts_crm_organization";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedback_posts_crm_contact"
  ON "feedback_posts"("org_id", "crm_contact_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedback_posts_crm_org"
  ON "feedback_posts"("org_id", "crm_organization_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

-- PM-001: CRM linkage on feedbucket_submissions
ALTER TABLE "feedbucket_submissions"
  ADD COLUMN "crm_contact_id" integer,
  ADD COLUMN "crm_organization_id" integer,
  ADD COLUMN "account_value_snapshot" numeric(15, 2);
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions"
  ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact"
    FOREIGN KEY ("crm_contact_id")
    REFERENCES "contacts"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_contact";
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions"
  ADD CONSTRAINT "fk_feedbucket_submissions_crm_org"
    FOREIGN KEY ("crm_organization_id")
    REFERENCES "crm_organizations"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_crm_org";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_crm_contact"
  ON "feedbucket_submissions"("org_id", "crm_contact_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_crm_org"
  ON "feedbucket_submissions"("org_id", "crm_organization_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

-- PM-002: RICE scoring inputs on roadmap_items
ALTER TABLE "roadmap_items"
  ADD COLUMN "reach" integer,
  ADD COLUMN "impact" integer,
  ADD COLUMN "confidence" integer,
  ADD COLUMN "effort" integer;
--> statement-breakpoint

-- PM-003: Product releases lifecycle entity
CREATE TABLE IF NOT EXISTS "managed_product_releases" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "managed_product_id" integer NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "release_date" date,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_managed_product_releases_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_managed_product_releases_status"
    CHECK (status IN ('draft', 'released', 'archived'))
);
--> statement-breakpoint

ALTER TABLE "managed_product_releases"
  ADD CONSTRAINT "fk_managed_product_releases_org"
    FOREIGN KEY ("org_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "managed_product_releases" VALIDATE CONSTRAINT "fk_managed_product_releases_org";
--> statement-breakpoint

ALTER TABLE "managed_product_releases"
  ADD CONSTRAINT "fk_managed_product_releases_product"
    FOREIGN KEY ("managed_product_id")
    REFERENCES "managed_products"("managed_product_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "managed_product_releases" VALIDATE CONSTRAINT "fk_managed_product_releases_product";
--> statement-breakpoint

ALTER TABLE "managed_product_releases"
  ADD CONSTRAINT "fk_managed_product_releases_created_by"
    FOREIGN KEY ("created_by")
    REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "managed_product_releases" VALIDATE CONSTRAINT "fk_managed_product_releases_created_by";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_managed_product_releases_product"
  ON "managed_product_releases"("managed_product_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_managed_product_releases_org_status"
  ON "managed_product_releases"("org_id", "status");
--> statement-breakpoint

-- PM-013: Widget-to-product linkage on feedbucket_widgets
ALTER TABLE "feedbucket_widgets"
  ADD COLUMN "managed_product_id" integer;
--> statement-breakpoint

ALTER TABLE "feedbucket_widgets"
  ADD CONSTRAINT "fk_feedbucket_widgets_managed_product"
    FOREIGN KEY ("managed_product_id")
    REFERENCES "managed_products"("managed_product_id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_managed_product";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedbucket_widgets_managed_product"
  ON "feedbucket_widgets"("org_id", "managed_product_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

ANALYZE "feedback_posts";
--> statement-breakpoint

ANALYZE "feedbucket_submissions";
--> statement-breakpoint

ANALYZE "roadmap_items";
--> statement-breakpoint

ANALYZE "feedbucket_widgets";
--> statement-breakpoint

ANALYZE "managed_product_releases";