SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1161 precondition: build.projects is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'projects'
       AND column_name = 'invoice_line_detail'
  ) THEN
    RAISE EXCEPTION '1161 precondition: build.projects.invoice_line_detail already exists — this migration has run';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_line_detail') THEN
    CREATE TYPE "public"."invoice_line_detail" AS ENUM ('summary', 'raw');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD COLUMN IF NOT EXISTS "invoice_line_detail" "public"."invoice_line_detail" NOT NULL DEFAULT 'summary';
