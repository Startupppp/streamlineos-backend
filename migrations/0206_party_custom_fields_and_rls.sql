-- Custom SQL migration file, put your code below! --

-- Party records: tenant-scoped custom fields, covering indexes the planner can
-- actually use under RLS, and the policies themselves.
--
-- Authored by hand via `generate --custom` because `db:generate` cannot run
-- non-interactively here; see 0205 for the detail. The Drizzle snapshot does not
-- yet carry custom_fields.

SET lock_timeout = '5s';

--> statement-breakpoint
-- Industry-specific attributes without a migration per tenant. JSONB rather than
-- a normalised table because these are opaque display values, never a lifecycle
-- entity — anything with a status or a history gets its own table.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb;

--> statement-breakpoint
ALTER TABLE "party_contacts" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb;

--> statement-breakpoint
-- Leading organization_id is not stylistic. The RLS policy adds
-- `organization_id = app.current_org_id()`, which is not leakproof, so it is
-- evaluated against the heap tuple; an index that does not itself supply
-- organization_id can never satisfy an index-only scan and the planner declines
-- it entirely. Partial on deleted_at because every read filters soft-deleted rows.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_created"
  ON "business_parties" ("organization_id", "created_at" DESC, "party_id" DESC)
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- The same order, narrowed by type, for a filtered list.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_type_created"
  ON "business_parties" ("organization_id", "party_type", "created_at" DESC, "party_id" DESC)
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_party_contacts_org_party_live"
  ON "party_contacts" ("organization_id", "party_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide, because grants
-- arrive through ALTER DEFAULT PRIVILEGES and a missing policy is silent.
ALTER TABLE "business_parties" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "business_parties";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "business_parties"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "business_parties" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_parties" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "party_contacts" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "party_contacts";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "party_contacts"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "party_contacts" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "party_contacts" TO streamline_app;

--> statement-breakpoint
-- Stats and the visibility map decide whether the new partial indexes are usable
-- at all; without this an index-only scan is refused regardless of the index.
ANALYZE "business_parties";

--> statement-breakpoint
ANALYZE "party_contacts";
