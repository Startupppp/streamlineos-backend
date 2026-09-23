SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.business_parties') IS NULL THEN
    RAISE EXCEPTION '1160 precondition: public.business_parties is absent — this is not a StreamlineOS CRM database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'business_parties'
       AND column_name = 'tier'
  ) THEN
    RAISE EXCEPTION '1160 precondition: public.business_parties.tier already exists — this migration has run';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_account_tier') THEN
    CREATE TYPE "public"."crm_account_tier" AS ENUM ('free', 'pro', 'enterprise');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."business_parties"
  ADD COLUMN IF NOT EXISTS "tier" "public"."crm_account_tier";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_business_parties_org_tier"
  ON "public"."business_parties" ("organization_id", "tier")
  WHERE "deleted_at" IS NULL AND "tier" IS NOT NULL;
