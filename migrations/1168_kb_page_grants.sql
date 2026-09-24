SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1168 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF to_regclass('public.kb_page_grants') IS NOT NULL THEN
    RAISE EXCEPTION '1168 precondition: public.kb_page_grants already exists — this migration has run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_pages_org_id') THEN
    RAISE EXCEPTION '1168 precondition: uniq_kb_pages_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  -- Resolved by column set, not by constraint name: production carries this as
  -- uniq_org_members_org_id_key, and a name guess reads as a missing object.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.organization_members'::regclass
      AND c.contype IN ('u', 'p')
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['id', 'org_id']
  ) THEN
    RAISE EXCEPTION '1168 precondition: public.organization_members has no UNIQUE (org_id, id) — the tenant-safe composite foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_page_grants" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "membership_id" integer,
  "role" text,
  "access" text NOT NULL DEFAULT 'view',
  "granted_by_membership_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "revoked_at" timestamp,
  CONSTRAINT "uniq_kb_page_grants_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_kb_page_grants_access" CHECK ("access" IN ('view', 'comment', 'edit', 'manage')),
  CONSTRAINT "chk_kb_page_grants_grantee_arc" CHECK (
    ("membership_id" IS NOT NULL AND "role" IS NULL)
    OR ("membership_id" IS NULL AND "role" IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_grants_live_membership"
  ON "public"."kb_page_grants" ("org_id", "page_id", "membership_id")
  WHERE "revoked_at" IS NULL AND "membership_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_grants_live_role"
  ON "public"."kb_page_grants" ("org_id", "page_id", "role")
  WHERE "revoked_at" IS NULL AND "role" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_grants_org_membership_live"
  ON "public"."kb_page_grants" ("org_id", "membership_id", "revoked_at", "page_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_grants_org_role_live"
  ON "public"."kb_page_grants" ("org_id", "role", "revoked_at", "page_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_grants_org_page_live"
  ON "public"."kb_page_grants" ("org_id", "page_id", "revoked_at")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_grants_org_granted_by"
  ON "public"."kb_page_grants" ("org_id", "granted_by_membership_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_page_grants"
  ADD CONSTRAINT "kb_page_grants_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_page_grants"
  VALIDATE CONSTRAINT "kb_page_grants_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_grants"
  ADD CONSTRAINT "fk_kb_page_grants_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_page_grants"
  VALIDATE CONSTRAINT "fk_kb_page_grants_org_page";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_grants"
  ADD CONSTRAINT "fk_kb_page_grants_org_membership"
  FOREIGN KEY ("org_id", "membership_id") REFERENCES "public"."organization_members" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_page_grants"
  VALIDATE CONSTRAINT "fk_kb_page_grants_org_membership";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_grants"
  ADD CONSTRAINT "fk_kb_page_grants_org_granted_by_membership"
  FOREIGN KEY ("org_id", "granted_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id") ON DELETE SET NULL ("granted_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_page_grants"
  VALIDATE CONSTRAINT "fk_kb_page_grants_org_granted_by_membership";
--> statement-breakpoint

ALTER TABLE "public"."kb_page_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_page_grants";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."kb_page_grants"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."kb_page_grants" TO streamline_app;
