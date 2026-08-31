SET lock_timeout = '5s';

ALTER TABLE "agent_tokens" ADD COLUMN IF NOT EXISTS "issuer_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN IF NOT EXISTS "scopes" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

UPDATE "agent_tokens" AS t
SET "issuer_membership_id" = m."id"
FROM "organization_members" AS m
WHERE m."org_id" = t."org_id"
  AND m."user_id" = t."user_id"
  AND t."issuer_membership_id" IS NULL;
--> statement-breakpoint

UPDATE "agent_tokens"
SET "scopes" = ARRAY[
  'build:view',
  'build:create',
  'build:tickets:view',
  'build:tickets:create',
  'build:tickets:update'
]::text[]
WHERE "scopes" = '{}'::text[];
--> statement-breakpoint

DO $$
DECLARE unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped FROM "agent_tokens" WHERE "issuer_membership_id" IS NULL;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'agent_tokens: % row(s) have no organization_members row for (org_id, user_id). Revoke or map them before applying this migration; they are reported, not dropped.', unmapped;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "agent_tokens" ALTER COLUMN "issuer_membership_id" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_tokens_issuer_membership'
  ) THEN
    ALTER TABLE "agent_tokens"
      ADD CONSTRAINT "fk_agent_tokens_issuer_membership"
      FOREIGN KEY ("org_id", "issuer_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE CASCADE
      NOT VALID;
    
    ALTER TABLE "agent_tokens" VALIDATE CONSTRAINT "fk_agent_tokens_issuer_membership";
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_tokens_org_issuer"
  ON "agent_tokens" ("org_id", "issuer_membership_id");
