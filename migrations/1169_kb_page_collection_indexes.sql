SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1169 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_updated_keyset"
  ON "public"."kb_pages" ("org_id", "updated_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_created_keyset"
  ON "public"."kb_pages" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_title_keyset"
  ON "public"."kb_pages" ("org_id", "title", "id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_owner_updated_keyset"
  ON "public"."kb_pages" ("org_id", "owner_membership_id", "updated_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "owner_membership_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_space_live"
  ON "public"."kb_pages" ("org_id", "space_id")
  WHERE "deleted_at" IS NULL AND "space_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_deleted_keyset"
  ON "public"."kb_pages" ("org_id", "deleted_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NOT NULL;
