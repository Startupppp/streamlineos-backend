-- Custom SQL migration file, put your code below! --

-- Party roles, merge history and the duplicate review queue.
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_roles" (
  "party_role_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "role" text NOT NULL,
  "assigned_by" text,
  "assigned_at" timestamp DEFAULT now() NOT NULL,
  "removed_at" timestamp
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_merges" (
  "party_merge_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "survivor_party_id" text NOT NULL,
  "merged_party_id" text NOT NULL,
  "decided_by" text NOT NULL,
  "decided_by_user_id" text,
  "confidence" double precision,
  "signals" jsonb,
  "conflicts" jsonb,
  "snapshot" jsonb NOT NULL,
  "merged_at" timestamp DEFAULT now() NOT NULL,
  "reverted_at" timestamp,
  "reverted_by_user_id" text
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_duplicate_candidates" (
  "candidate_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "low_party_id" text NOT NULL,
  "high_party_id" text NOT NULL,
  "score" double precision NOT NULL,
  "signals" jsonb,
  "blockers" jsonb,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "detected_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp,
  "resolved_by_user_id" text
);

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding the key does not hold ACCESS EXCLUSIVE on
-- organizations while it installs triggers.
ALTER TABLE "party_roles" ADD CONSTRAINT "fk_party_roles_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "party_roles" VALIDATE CONSTRAINT "fk_party_roles_org";
--> statement-breakpoint
ALTER TABLE "party_merges" ADD CONSTRAINT "fk_party_merges_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "party_merges" VALIDATE CONSTRAINT "fk_party_merges_org";
--> statement-breakpoint
ALTER TABLE "party_duplicate_candidates" ADD CONSTRAINT "fk_party_dupes_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "party_duplicate_candidates" VALIDATE CONSTRAINT "fk_party_dupes_org";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_party_roles_party_role"
  ON "party_roles" ("organization_id", "party_id", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_party_roles_org_role"
  ON "party_roles" ("organization_id", "role", "party_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_party_merges_org_survivor"
  ON "party_merges" ("organization_id", "survivor_party_id", "merged_at");
--> statement-breakpoint
-- A record can only be the loser of one merge that has not been reverted.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_party_merges_merged_live"
  ON "party_merges" ("organization_id", "merged_party_id") WHERE "reverted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_party_duplicate_pair"
  ON "party_duplicate_candidates" ("organization_id", "low_party_id", "high_party_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_party_duplicate_queue"
  ON "party_duplicate_candidates" ("organization_id", "status", "score");

--> statement-breakpoint
-- Existing parties carry their single type across as a role. BOTH becomes two
-- rows, which is the case the old enum could not express and the reason this
-- table exists.
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role")
SELECT gen_random_uuid()::text, "organization_id", "party_id",
       CASE WHEN "party_type" = 'BOTH' THEN 'CUSTOMER' ELSE "party_type"::text END
FROM "business_parties"
WHERE "deleted_at" IS NULL
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "party_roles" ("party_role_id", "organization_id", "party_id", "role")
SELECT gen_random_uuid()::text, "organization_id", "party_id", 'VENDOR'
FROM "business_parties"
WHERE "deleted_at" IS NULL AND "party_type" = 'BOTH'
ON CONFLICT DO NOTHING;

--> statement-breakpoint
ANALYZE "party_roles";
