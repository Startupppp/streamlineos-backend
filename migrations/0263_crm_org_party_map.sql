-- Custom SQL migration file, put your code below! --

-- The fourth map: which Party a `crm_organizations` id means.
--
-- Same shape as `lead_party_map`, `client_party_map` and `contact_party_map`
-- from 0240, and for the same reason. A company id is held by a URL somebody
-- bookmarked, by `tickets.customer_id`, by `roadmap_items.crm_organization_id`
-- and by `feedbucket_submissions.crm_organization_id`, and every one of those has
-- to keep resolving after the record moves to Party.
--
-- A real table with real composite foreign keys, not a polymorphic
-- `(kind, id)` pair. The polymorphic shape carries no referential integrity, so
-- nothing would stop a row pointing at a company that no longer exists, and a
-- resolution that quietly returns the WRONG company is worse than one that
-- fails. With the foreign key, deleting the legacy row takes the mapping with it
-- and the resolver simply misses.
--
-- `crm_org_party_map`, not `organization_party_map`: `organizations` is the
-- TENANT table here, and a map by that name would read as tenants mapping to
-- parties.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_org_party_map" (
  "organization_id" text NOT NULL,
  "crm_organization_id" integer NOT NULL,
  "party_id" text NOT NULL,
  -- `migration:0264` for the backfill, a user id when somebody re-pointed it.
  "linked_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pk_crm_org_party_map" PRIMARY KEY ("organization_id", "crm_organization_id")
);

--> statement-breakpoint
/*
 * `uniq_crm_organizations_org_id` exists ONLY as a Drizzle declaration --
 * `contacts.ts` declares it and no migration in this repository has ever created
 * it. It is present in databases built or touched by `drizzle-kit push`, which is
 * why nothing has noticed; a database built purely by running migrations in order
 * would abort on the foreign key below with
 * `42830: there is no unique constraint matching given keys`. This is the third
 * time this exact trap has appeared in the series -- see the same block in 0228
 * for `uniq_quotes_org_id` and in 0240 for the three legacy identity tables.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_crm_organizations_org_id') THEN
    IF EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'uniq_crm_organizations_org_id' AND relkind = 'i'
    ) THEN
      ALTER TABLE "crm_organizations"
        ADD CONSTRAINT "uniq_crm_organizations_org_id" UNIQUE USING INDEX "uniq_crm_organizations_org_id";
    ELSE
      ALTER TABLE "crm_organizations"
        ADD CONSTRAINT "uniq_crm_organizations_org_id" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i'
    ) THEN
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "crm_org_party_map" ADD CONSTRAINT "fk_crm_org_party_map_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_org_party_map" VALIDATE CONSTRAINT "fk_crm_org_party_map_org";

--> statement-breakpoint
ALTER TABLE "crm_org_party_map" ADD CONSTRAINT "fk_crm_org_party_map_crm_org"
  FOREIGN KEY ("organization_id", "crm_organization_id")
  REFERENCES "crm_organizations"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_org_party_map" VALIDATE CONSTRAINT "fk_crm_org_party_map_crm_org";

--> statement-breakpoint
ALTER TABLE "crm_org_party_map" ADD CONSTRAINT "fk_crm_org_party_map_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_org_party_map" VALIDATE CONSTRAINT "fk_crm_org_party_map_party";

--> statement-breakpoint
-- The reverse read: which company ids this party answers to. The merge needs it
-- to re-point them, and it is how the Companies list gets an integer id to show.
-- Deliberately not unique on `party_id`: after a merge several company ids
-- legitimately answer to one surviving Party, which is the point of it.
CREATE INDEX IF NOT EXISTS "idx_crm_org_party_map_party"
  ON "crm_org_party_map" ("organization_id", "party_id");

--> statement-breakpoint
ALTER TABLE "crm_org_party_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_org_party_map";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_org_party_map"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_org_party_map" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_org_party_map" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_org_party_map";
