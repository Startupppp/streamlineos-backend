SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "account_organization_index"
  ADD COLUMN IF NOT EXISTS "last_activated_at" timestamptz;
--> statement-breakpoint
UPDATE "account_organization_index" aoi
SET "last_activated_at" = NOW()
FROM "users" u
WHERE aoi."user_id" = u."id"
  AND aoi."org_id" = u."last_active_org_id"
  AND u."last_active_org_id" IS NOT NULL
  AND aoi."last_activated_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_org_index_last_activated"
  ON "account_organization_index" ("user_id", "last_activated_at" DESC NULLS LAST);
