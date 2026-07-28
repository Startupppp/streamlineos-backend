SET statement_timeout = 0;
-- 0335 — normalize org array columns and harden invitations
-- =============================================================================
-- 1. DROP organizations.enabled_modules (text[])
--    Duplicates the org_modules table, which is the sole read/write authority.
--    The array was stale and actively disagreed with org_modules on live data.
--
-- 2. REPLACE organizations.allowed_email_domains (text[]) with child table
--    organization_allowed_email_domains so domains are individually indexed,
--    tenant-scoped, and can carry metadata (e.g. created_at). The array column
--    values are back-filled before the column is dropped so populated databases
--    retain their data.
--
-- 3. HARDEN invitations
--    a. Rename token → token_hash (the service already stores a SHA-256 hash;
--       this makes the invariant explicit and the column name honest).
--    b. Rename revoked_by (integer, no FK) → revoked_by_membership_id with a
--       proper FK to organization_members(id) ON DELETE SET NULL, matching how
--       inviter_membership_id / accepted_membership_id are already modelled.
-- =============================================================================

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "enabled_modules";
--> statement-breakpoint
CREATE TABLE "organization_allowed_email_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_org_allowed_domains_org_domain" UNIQUE ("org_id", "domain")
);
--> statement-breakpoint
CREATE INDEX "idx_org_allowed_domains_org" ON "organization_allowed_email_domains" ("org_id");
--> statement-breakpoint
INSERT INTO "organization_allowed_email_domains" ("id", "org_id", "domain", "created_at")
SELECT
  gen_random_uuid(),
  o.id,
  lower(d.domain),
  now()
FROM "organizations" o, unnest(o.allowed_email_domains) AS d(domain)
WHERE o.allowed_email_domains IS NOT NULL
  AND array_length(o.allowed_email_domains, 1) > 0
ON CONFLICT ON CONSTRAINT "uniq_org_allowed_domains_org_domain" DO NOTHING;
--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "allowed_email_domains";
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS "invitations_token_unique";
--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "token" TO "token_hash";
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_hash_unique" UNIQUE ("token_hash");
--> statement-breakpoint
ALTER TABLE "invitations" RENAME COLUMN "revoked_by" TO "revoked_by_membership_id";
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revoked_by_membership_id_organization_members_id_fk"
  FOREIGN KEY ("revoked_by_membership_id") REFERENCES "organization_members"("id") ON DELETE SET NULL;
