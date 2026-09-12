-- 0589.down — Recreate the reason-codes table 0589 dropped.
--
-- The only inventory rollback that CREATES rather than drops, because 0589 is
-- the only inventory migration whose forward direction is a drop.
--
-- The table comes back empty, and that is a true inverse rather than a
-- compromise: 0589 refuses to drop the table at all unless it holds zero rows,
-- so on any database where the drop actually happened there was nothing in it.
-- Where 0589 declined, this file finds the table already present and IF NOT
-- EXISTS makes it a no-op -- which is the correct behaviour, and is also why
-- this file must never be the head of a tier-1 suffix on such a database.
--
-- The DDL is 0407's, verbatim. inv_reason_category is deliberately not
-- recreated: 0589 left the type in place on purpose, so it is still there.
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inv_reason_codes" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "category" "inv_reason_category" DEFAULT 'ADJUSTMENT' NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_reason_codes_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_reason_codes_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_reason_codes_org_code" ON "inv_reason_codes" ("org_id", "code");
