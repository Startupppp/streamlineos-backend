-- Custom SQL migration file, put your code below! --

-- Every address a party can be reached at, as rows rather than as columns.
--
-- Phase 1 put the ingress seam at the highest point it could defend, on the
-- argument that a new channel would cost an adapter and nothing else. Three
-- adapters -- telephony, WhatsApp, web forms -- reported the same defect
-- independently: the seam held, and everything below it was email-shaped.
-- `resolve-party` matched `business_parties.email` and, on a miss, inserted the
-- sender's address into that column. Hand it a telephone number and it wrote a
-- telephone number into the email column. The row looked right; the same
-- person's next email did not match it, so they became a second record and the
-- first was unreachable by the only channel that was wired.
--
-- A row per identifier rather than a column per channel, for the reason ticket
-- 01 refused `clients.is_vendor` a column and made it a `party_roles` row: a
-- party has many, of varying kinds, and the set grows with the product. One
-- column and one matching branch per kind means the fifth channel pays exactly
-- what the fourth paid -- the same claim failing twice in the same place -- and
-- it is ambiguous on arrival, because a telephone number could match `phone` or
-- `whatsapp_phone` and nothing says which wins.
--
-- `business_parties.email`, `.phone` and `.whatsapp_phone` stay. They are
-- display fields from here on; they stop being the matching mechanism.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_identifiers" (
  "party_identifier_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "kind" text NOT NULL,
  -- What arrived, verbatim: it is what a person recognises on the record.
  "value" text NOT NULL,
  -- The one thing ever matched on. Stored rather than computed at query time so
  -- that the uniqueness below is a constraint the database enforces rather than
  -- a convention every caller has to remember.
  "normalised_value" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- The database's copy of the vocabulary. The other copy is `IDENTIFIER_KINDS`
-- in `modules/ingress/inbound-event.ts`, and `party-identifiers.spec.ts` reads
-- this file to fail if the two ever disagree. `handle` is the honest name for an
-- opaque address on a channel that is neither mail nor a telephone line -- it
-- exists so a participant is never dropped for want of a kind, which is what
-- `externalParticipants` used to do to every caller.
ALTER TABLE "party_identifiers" ADD CONSTRAINT "chk_party_identifiers_kind"
  CHECK ("kind" IN ('email', 'phone', 'whatsapp', 'handle'));

--> statement-breakpoint
ALTER TABLE "party_identifiers" ADD CONSTRAINT "chk_party_identifiers_normalised"
  CHECK (length(btrim("normalised_value")) > 0);

--> statement-breakpoint
ALTER TABLE "party_identifiers" ADD CONSTRAINT "fk_party_identifiers_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "party_identifiers" VALIDATE CONSTRAINT "fk_party_identifiers_org";

--> statement-breakpoint
/*
 * The composite FK below needs a unique constraint on exactly
 * ("organization_id", "party_id"). `0307` creates it as an index and `0324`
 * promotes it, both journalled before this -- this block is belt and braces for
 * a database built by another route. Promotes the existing index rather than
 * duplicating it, following `0228` and `0250`.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i') THEN
      ALTER TABLE "business_parties" ADD CONSTRAINT "uniq_business_parties_org_party"
        UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties" ADD CONSTRAINT "uniq_business_parties_org_party"
        UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
/*
 * CASCADE, and composite so the tenant travels with the reference.
 *
 * Not `SET NULL`: a composite `ON DELETE SET NULL` nulls "organization_id" too,
 * which is NOT NULL here, so deleting a party would fail outright -- the trap
 * 0240 recorded on `business_parties.acquisition_campaign_id`. An identifier
 * with no party is meaningless anyway; it exists to name one.
 */
ALTER TABLE "party_identifiers" ADD CONSTRAINT "fk_party_identifiers_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "party_identifiers" VALIDATE CONSTRAINT "fk_party_identifiers_party";

--> statement-breakpoint
/*
 * The backfill, before the unique index rather than after it.
 *
 * The DISTINCT ON below already picks one row per (organisation, kind, value),
 * so the index would hold either way -- but building it afterwards means a
 * disagreement between this SQL and `normaliseIdentifier` shows up as a
 * constraint violation the migration fails on, rather than as rows quietly
 * winning a race.
 *
 * Only live parties. A soft-deleted record holding a claim on an address would
 * mean the deletion permanently poisoned it: nobody else could ever be recorded
 * under that number. `resolvePartyByIdentifier` releases such a claim if one
 * appears by another route, and this simply never creates one.
 *
 * The normalisation is `normaliseIdentifier`'s rule written in SQL, which is a
 * second implementation and is acknowledged as one. A migration cannot call
 * TypeScript, so the only honest mitigation is to prove the two agree on real
 * rows -- `party-identifiers.db.spec.ts` runs this file and compares its output
 * against the function, value by value.
 */
INSERT INTO "party_identifiers"
  ("party_identifier_id", "organization_id", "party_id", "kind", "value", "normalised_value")
SELECT DISTINCT ON (claimed."organization_id", claimed."kind", claimed."normalised_value")
  gen_random_uuid()::text,
  claimed."organization_id",
  claimed."party_id",
  claimed."kind",
  claimed."value",
  claimed."normalised_value"
FROM (
  SELECT
    p."organization_id",
    p."party_id",
    p."created_at",
    source."kind",
    btrim(source."raw") AS "value",
    CASE
      WHEN source."kind" = 'email' THEN lower(btrim(source."raw"))
      WHEN btrim(source."raw") LIKE '+%'
        THEN '+' || regexp_replace(source."raw", '\D', '', 'g')
      WHEN regexp_replace(source."raw", '\D', '', 'g') LIKE '00%'
        THEN '+' || substring(regexp_replace(source."raw", '\D', '', 'g') FROM 3)
      ELSE regexp_replace(source."raw", '\D', '', 'g')
    END AS "normalised_value"
  FROM "business_parties" p
  CROSS JOIN LATERAL (
    VALUES
      ('email', p."email"),
      ('phone', p."phone"),
      -- `leads.whatsapp_number` became `whatsapp_phone` in 0240, and it is a
      -- channel rather than a second telephone column -- so it claims its own
      -- kind rather than being folded into `phone`.
      ('whatsapp', p."whatsapp_phone")
  ) AS source("kind", "raw")
  WHERE p."deleted_at" IS NULL
    AND source."raw" IS NOT NULL
    AND btrim(source."raw") <> ''
) AS claimed
WHERE claimed."normalised_value" <> ''
-- Oldest record wins a contested value, which is also what `claimIdentifiers`
-- does at runtime: the first claim stands and the loser is left as a duplicate
-- for the merge machinery to find. Deterministic, so re-running lands the same
-- way round.
ORDER BY claimed."organization_id", claimed."kind", claimed."normalised_value",
         claimed."created_at", claimed."party_id"
ON CONFLICT DO NOTHING;

--> statement-breakpoint
/*
 * One party per identifier, per organisation. Not "usually" -- enforced.
 *
 * Two parties holding one telephone number is the failure this whole table
 * exists to make impossible. The resolver would take whichever row came back
 * first, so the same caller would land on one record today and the other
 * tomorrow, and neither would ever look wrong.
 */
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_party_identifiers_value"
  ON "party_identifiers" ("organization_id", "kind", "normalised_value");

--> statement-breakpoint
-- The reverse read: everything this party is reachable at, which is what a merge
-- moves and what the duplicate scorer compares.
CREATE INDEX IF NOT EXISTS "idx_party_identifiers_party"
  ON "party_identifiers" ("organization_id", "party_id", "kind");

--> statement-breakpoint
ALTER TABLE "party_identifiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "party_identifiers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "party_identifiers"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "party_identifiers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "party_identifiers" TO streamline_app;

--> statement-breakpoint
ANALYZE "party_identifiers";
