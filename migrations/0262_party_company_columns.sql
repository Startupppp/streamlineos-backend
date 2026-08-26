-- Custom SQL migration file, put your code below! --

-- Party learns what a company is, and who somebody works for.
--
-- Ticket 25. The phase treated `contacts`, `clients`, `leads` and
-- `business_parties` as the identity split; it was five tables.
-- `crm_organizations` is a company record with a name, a domain, an industry, a
-- size, a health score, a parent pointer, a merge pointer and its own merge
-- service, which is Party built a second time with its own duplicate handling.
-- This is the expand step that gives Party somewhere to put all of it.
--
-- `party_kind` is a NEW enum rather than a fifth value in `party_type`, and that
-- is the decision the ticket asked for. `party_type` is a *relationship*
-- vocabulary -- CUSTOMER, VENDOR, PARTNER, BOTH, what a party is TO US -- and
-- `party_roles` already says the same thing properly, which is why 0241 stopped
-- expressing `clients.is_vendor` as a boolean. Being a company is not a
-- relationship: it is not multi-valued, it does not change when a prospect
-- becomes a customer, and a company is obviously both an organisation AND a
-- customer. Adding ORGANISATION to `party_type` would force a choice between
-- those two and repeat the mistake this phase has now refused three times.
--
-- Nullable, with no default. Nothing in `leads`, `clients` or `contacts` records
-- whether a record is a person or a company, so a NOT NULL default of PERSON
-- would assert something false about every client that is a limited company.
-- NULL means nobody has said; 0264 sets ORGANISATION on the one set the data
-- genuinely knows about.
--
-- `employer_party_id` is a COMPOSITE tenant foreign key. A single-column one is
-- the cross-tenant hole the issues table deliberately avoided, and there is no
-- reason to reopen it for a self-reference.
--
-- ON DELETE CASCADE, where the instinct is SET NULL. A composite SET NULL nulls
-- BOTH columns and `organization_id` is NOT NULL, so the delete would simply
-- fail. CASCADE is safe here as a fact rather than a hope: the repository was
-- grepped and nothing hard-deletes a party -- there is no `delete(businessParties)`
-- and no `DELETE FROM business_parties` anywhere -- the application soft-deletes
-- through `deleted_at`, so the only DELETE that ever reaches this table is the
-- tenant cascade, where the employees are going with it anyway. Read CASCADE here
-- as "the tenant went", not "somebody deleted a company".
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "party_kind" AS ENUM ('PERSON', 'ORGANISATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "party_kind" "party_kind";
--> statement-breakpoint
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "employer_party_id" text;
--> statement-breakpoint
-- The company's own internet domain, which is not its `website`: the website is
-- `https://www.acme.com/en/` and the domain is `acme.com`, and only the second is
-- a matching key. Not a `party_identifiers` row -- that vocabulary is closed by
-- the CHECK in 0260 and pinned to `IDENTIFIER_KINDS` in the ingress seam, and a
-- domain is not something an inbound message arrives from.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "domain" text;
--> statement-breakpoint
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "industry" text;
--> statement-breakpoint
-- Reusing the existing `org_size` enum rather than declaring a second one with
-- the same five values.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "company_size" "org_size";
--> statement-breakpoint
-- `crm_organizations` carries both `notes` and `description`, and they are not
-- the same field: one goes on a customer-facing profile and the other does not.
-- Folding them together would lose the distinction in the direction that matters.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "description" text;

--> statement-breakpoint
/*
 * The composite FK below needs a unique constraint on exactly
 * ("organization_id", "party_id"). 0240 promotes it and so do 0250, 0260, 0290
 * and 0324 -- each independently, because a migration may not assume a later one
 * ran. Promotes an existing unique index rather than duplicating it: a dependent
 * foreign key blocks a DROP INDEX, so `ADD CONSTRAINT ... USING INDEX` is the
 * only way through.
 */
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
-- The employer index first: without it the foreign key's own delete-time lookup
-- is a sequential scan of the whole table, and VALIDATE below reads every row.
-- Partial because almost no party has an employer -- a company does not, and
-- neither does a lead who only ever typed a company name into a form.
CREATE INDEX IF NOT EXISTS "idx_business_parties_employer"
  ON "business_parties" ("organization_id", "employer_party_id")
  WHERE "employer_party_id" IS NOT NULL;

--> statement-breakpoint
-- NOT VALID then VALIDATE, never one statement: ADD CONSTRAINT ... FOREIGN KEY
-- takes ACCESS EXCLUSIVE on both sides while it installs the triggers, and both
-- sides here are the same large table.
ALTER TABLE "business_parties" ADD CONSTRAINT "fk_business_parties_employer"
  FOREIGN KEY ("organization_id", "employer_party_id")
  REFERENCES "business_parties"("organization_id", "party_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "fk_business_parties_employer";

--> statement-breakpoint
-- Nobody employs themselves. A one-hop cycle is the only one a constraint can
-- see; deeper ones stay the application's problem, as they already are for
-- `crm_organizations.parent_id`.
ALTER TABLE "business_parties" ADD CONSTRAINT "chk_business_parties_employer_not_self"
  CHECK ("employer_party_id" IS NULL OR "employer_party_id" <> "party_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "chk_business_parties_employer_not_self";

--> statement-breakpoint
-- The Companies list: every organisation in the tenant.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_kind"
  ON "business_parties" ("organization_id", "party_kind")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- Duplicate detection by domain, which is the strongest signal a company has.
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_domain"
  ON "business_parties" ("organization_id", "domain")
  WHERE "domain" IS NOT NULL;

--> statement-breakpoint
ANALYZE "business_parties";
