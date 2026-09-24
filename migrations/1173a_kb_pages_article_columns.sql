SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1173a precondition: public.kb_pages is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_pages'
      AND a.attname = 'external_id' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '1173a precondition: kb_pages.external_id is absent — apply 1172 first';
  END IF;
  IF to_regclass('public.kb_categories') IS NULL THEN
    RAISE EXCEPTION '1173a precondition: public.kb_categories is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "slug" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "excerpt" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "category_id" integer;
--> statement-breakpoint

-- Counters: nullable so existing rows receive NULL rather than a misleading 0.
-- DEFAULT 0 ensures new pages written after this migration get a sensible value.
ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "views" integer DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "helpful_count" integer DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "not_helpful_count" integer DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "seo_title" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "seo_description" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "review_interval_days" integer;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "published_at" timestamp;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;
--> statement-breakpoint

-- Partial unique index: slug is the help-centre URL key, distinct from public_slug
-- (the wiki share slug). Every existing row is NULL so a non-partial index would
-- collide. Per BE-40 the index leads with org_id.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_org_slug_ref"
  ON "public"."kb_pages" ("org_id", "slug")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint

-- NOT VALID so the scan does not hold ACCESS EXCLUSIVE while kb_pages is in use.
-- After this migration runs 1173 backfills only rows that have a valid category,
-- so VALIDATE will trivially succeed on a fresh application.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_kb_pages_org_category'
      AND conrelid = 'public.kb_pages'::regclass
  ) THEN
    ALTER TABLE "public"."kb_pages"
      ADD CONSTRAINT "fk_kb_pages_org_category"
      FOREIGN KEY ("org_id", "category_id")
      REFERENCES "public"."kb_categories" ("org_id", "id")
      ON DELETE SET NULL (category_id)
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_category";
