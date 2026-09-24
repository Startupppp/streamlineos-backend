SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1172 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "external_source" text;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_kb_pages_external_ref_paired'
      AND conrelid = 'public.kb_pages'::regclass
  ) THEN
    ALTER TABLE "public"."kb_pages"
      ADD CONSTRAINT "chk_kb_pages_external_ref_paired"
      CHECK (("external_id" IS NULL) = ("external_source" IS NULL)) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "chk_kb_pages_external_ref_paired";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_external_ref"
  ON "public"."kb_pages" ("org_id", "external_source", "external_id")
  WHERE "external_id" IS NOT NULL;
